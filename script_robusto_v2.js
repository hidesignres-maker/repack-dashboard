/**
 * National Assortment Catalog - Robust Implementation V2
 * 
 * Arquitectura V2:
 * - DataStore: Fuente única de verdad
 * - Validators: Validación de esquema
 * - FilterStrategies: Patrón de filtros componibles
 * - ColumnDefinitions: Definición de columnas de la tabla (UI-driven)
 * - PaginationEngine: Paginación separada
 * - DataAccessor: Búsqueda, filtrado, sorting usando FilterStrategies
 * - UIManager: Renderizado dinámico usando ColumnDefinitions
 * - EventHandler: Orquestación de eventos
 */


// ============================================================================
// UTILIDADES COMPARTIDAS
// ============================================================================
const escapeHtml = (text) => {
    if (!text) return '';
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text).replace(/[&<>"']/g, m => map[m]);
};

const formatDollar = (val) => {
    if (val === null || val === undefined || val === '') return '-';
    const num = parseFloat(String(val).replace(/[$,]/g, ''));
    if (isNaN(num)) return '-';
    return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

// ============================================================================
// VALIDATORS
// ============================================================================
const Validators = {
    validateProduct(product) {
        const requiredFields = ['status', 'bu', 'gtin', 'title'];
        const errors = [];
        for (const field of requiredFields) {
            if (!product[field] || typeof product[field] !== 'string') {
                errors.push(`Missing or invalid field: ${field}`);
            }
        }
        if (!Array.isArray(product.regions) && !Array.isArray(product.region)) {
            errors.push('Regions must be an array');
        }
        return { isValid: errors.length === 0, errors };
    },
    validateFilterState(filters) {
        const errors = [];
        if (filters.searchTerm && typeof filters.searchTerm !== 'string') errors.push('Search term must be string');
        if (filters.statusFilter && !Array.isArray(filters.statusFilter)) errors.push('Status filter must be array');
        return { isValid: errors.length === 0, errors };
    }
};

// ============================================================================
// TAG SYSTEM (Phase 1)
// ============================================================================
const TagManager = {
    library: [
        { id: 't1', label: 'Fusion' },
        { id: 't2', label: 'Overlap ASIN' },
        { id: 't3', label: 'Low ASP' },
        { id: 't4', label: 'Innovation 2026' },
        { id: 't5', label: 'Innovation 2025' }
    ],

    init() {
        // No duplicate detection needed for simple flat tags
    },

    getTag(idOrLabel) {
        return this.library.find(t => t.id === idOrLabel || t.label === idOrLabel);
    },
    
    getTags() {
        return this.library;
    }
};
// Tag library ready to use

// ============================================================================
// DATA STORE
// ============================================================================
const DataStore = {
    state: {
        items: [],
        filters: {
            view: 'total',
            searchTerm: '',
            statusFilter: [],
            buFilter: [],
            clientFilter: [],
            regionFilter: [],
            tagFilter: [],
            sortKey: null,
            sortDirection: 'asc',
            hasError: false
        },
        pagination: {
            pageSize: 10,
            currentPage: 1
        },
        selection: new Set()
    },

    init(items) {
        const validatedItems = items.filter(item => {
            const validation = Validators.validateProduct(item);
            if (!validation.isValid) {
                console.warn(`Invalid product skipped:`, item, validation.errors);
                return false;
            }
            return true;
        }).map((item, index) => {
            // Normalize regions field
            if (!item.regions && item.region) item.regions = item.region;
            if (!item.regions) item.regions = ['National'];
            
            // Ensure tags use label strings
            if (!item.tags) item.tags = [];
            
            // Derive statusClass
            const s = (item.status || '').toLowerCase();
            if (s === 'discontinued' || s === 'disco') {
                item.statusClass = 'discontinued';
            } else if (s === 'hub-active' || s === 'hub active') {
                item.statusClass = 'hubactive';
            } else if (s === 'upc-changes' || s === 'upc changes') {
                item.statusClass = 'upcchanges';
            } else {
                item.statusClass = s.replace(/[^a-z0-9]/g, '');
            }
            
            // Conflict indicator for demo (every 5th item)
            if (item.conflict === undefined) item.hasError = (index % 5 === 0);
            else item.hasError = item.conflict;
            
            // UPC change flag for segmented view
            item.hasUpcChange = (index % 6 === 0 && s !== 'discontinued');
            
            return item;
        });

        this.state.items = validatedItems;
        console.log(`✓ DataStore initialized with ${validatedItems.length} items`);
    },

    setFilters(newFilters) {
        const validation = Validators.validateFilterState(newFilters);
        if (!validation.isValid) {
            console.error('Invalid filter state:', validation.errors);
            return false;
        }
        Object.assign(this.state.filters, newFilters);
        // Reset page on filter change
        this.state.pagination.currentPage = 1;
        return true;
    },

    setSorting(key, direction) {
        this.state.filters.sortKey = key;
        this.state.filters.sortDirection = direction;
    },

    toggleSelection(sku) {
        if (this.state.selection.has(sku)) this.state.selection.delete(sku);
        else this.state.selection.add(sku);
    },

    getState() {
        return { ...this.state };
    }
};

// ============================================================================
// FILTER STRATEGIES
// ============================================================================
const FilterStrategies = {
    view: (item, viewType) => {
        if (viewType === 'total') return item.status !== 'DISCO' && item.status !== 'discontinued' && item.status !== 'upc-changes';
        if (viewType === 'disco') return item.status === 'DISCO' || item.status === 'discontinued';
        if (viewType === 'upc') return item.status === 'upc-changes';
        return true;
    },
    search: (item, term) => {
        if (!term || !term.trim()) return true;
        const lower = term.toLowerCase().trim();
        
        const tagsString = (item.tags || []).map(t => {
            return (typeof t === 'string') ? t.toLowerCase() : '';
        }).join(' ');

        return item.title.toLowerCase().includes(lower) ||
               (item.vendor || '').toLowerCase().includes(lower) ||
               (item.sku || '').toLowerCase().includes(lower) ||
               (item.upc || '').toLowerCase().includes(lower) ||
               item.gtin.toLowerCase().includes(lower) ||
               (item.brand || '').toLowerCase().includes(lower) ||
               tagsString.includes(lower);
    },
    status: (item, statuses) => {
        if (!statuses || statuses.length === 0) return true;
        // Map dropdown labels to data status values
        const labelMap = {
            'pipeline': 'pipeline',
            'pre-launch': 'pre-launch',
            'active': 'active',
            'hub active': 'hub-active',
            'lto': 'lto',
            'upc changes': 'upc-changes',
            'discontinuing': 'discontinuing',
            'disco': 'discontinued',
            'unknown - review': 'unknown',
            'unknown': 'unknown',
        };
        const mapped = statuses.map(s => labelMap[s.toLowerCase()] || s.toLowerCase());
        return mapped.includes(item.status) || mapped.includes(item.status.toLowerCase());
    },
    hasError: (item, flag) => {
        if (flag === true) return item.hasError === true;
        return true;
    },
    bu: (item, bus) => {
        if (!bus || bus.length === 0) return true;
        return bus.includes(item.bu);
    },
    region: (item, regions) => {
        if (!regions || regions.length === 0) return true;
        const itemRegions = (item.regions || item.region || []).filter(r => !r.startsWith('+'));
        return itemRegions.some(r => regions.includes(r));
    },
    tag: (item, tagIds) => {
        if (!tagIds || tagIds.length === 0) return true;
        if (!item.tags || item.tags.length === 0) return false;
        // Support both tag IDs and label strings
        const tagLabels = tagIds.map(tid => {
            const t = TagManager.getTag(tid);
            return t ? t.label : tid;
        });
        return tagLabels.some(label => item.tags.includes(label));
    },
    client: (item, clients) => {
        if (!clients || clients.length === 0) return true;
        return clients.includes(item.customer);
    }
};

// ============================================================================
// DATA ACCESSOR
// ============================================================================
const DataAccessor = {
    getFilteredData() {
        const filters = DataStore.state.filters;
        let results = [...DataStore.state.items];

        results = results.filter(item => {
            return FilterStrategies.view(item, filters.view) &&
                   FilterStrategies.search(item, filters.searchTerm) &&
                   FilterStrategies.status(item, filters.statusFilter) &&
                   FilterStrategies.hasError(item, filters.hasError) &&
                   FilterStrategies.bu(item, filters.buFilter) &&
                   FilterStrategies.region(item, filters.regionFilter) &&
                   FilterStrategies.tag(item, filters.tagFilter) &&
                   FilterStrategies.client(item, filters.clientFilter);
        });

        if (filters.sortKey) {
            results.sort((a, b) => {
                let aVal = a[filters.sortKey];
                let bVal = b[filters.sortKey];

                if (typeof aVal === 'string' && aVal.startsWith('$')) {
                    aVal = parseFloat(aVal.replace(/[$,]/g, ''));
                    bVal = parseFloat(bVal.replace(/[$,]/g, ''));
                }

                if (aVal < bVal) return filters.sortDirection === 'asc' ? -1 : 1;
                if (aVal > bVal) return filters.sortDirection === 'asc' ? 1 : -1;
                return 0;
            });
        }
        return results;
    },
    getFilteredCount() {
        return this.getFilteredData().length;
    }
};

// ============================================================================
// PAGINATION ENGINE
// ============================================================================
const PaginationEngine = {
    paginate(data, pageSize, currentPage) {
        // Fallback for logic where page might exceed limit
        const totalItems = data.length;
        const totalPages = Math.ceil(totalItems / pageSize) || 1;
        const page = Math.min(Math.max(1, currentPage), totalPages);
        
        const start = (page - 1) * pageSize;
        return data.slice(start, start + pageSize);
    }
};

// ============================================================================
// COLUMN DEFINITIONS
// ============================================================================
const buildRegionChips = (regions) => {
    if (!regions || regions.length === 0) return '-';
    const primaryRegions = regions.filter(r => !r.startsWith('+'));
    const extraRegionsCountStr = regions.find(r => r.startsWith('+'));
    
    let text = primaryRegions.join(', ');
    
    if (extraRegionsCountStr) {
        const extraCount = parseInt(extraRegionsCountStr.replace('+', ''), 10);
        if (extraCount > 0) text += ` +${extraCount}`;
    }
    
    return `<span style="font-size:12px; color:#4B5563; white-space:nowrap;">${escapeHtml(text)}</span>`;
};

const buildStatusBadge = (row) => {
    const statusClass = `status-${row.statusClass}`;
    // Display-friendly status labels
    const statusLabels = {
        'active': 'Active',
        'hub-active': 'Hub Active',
        'pipeline': 'Pipeline',
        'lto': 'LTO',
        'upc-changes': 'UPC Changes',
        'discontinued': 'DISCO',
        'discontinuing': 'Discontinuing',
        'unknown': 'Unknown',
        'pre-launch': 'Pre-launch',
    };
    const displayStatus = statusLabels[row.status] || escapeHtml(row.status);
    if (row.status === 'DISCO' || row.status === 'discontinued') {
        return `<span class="status-badge ${statusClass} has-tooltip"><span style="flex-shrink:0;">${displayStatus}</span><div class="tooltip-content" style="line-height: 1.5; padding: 6px 10px;">Discontinuation date: Oct 1, 2026<br>Status Date: April 18, 2026</div></span>`;
    }
    return `<span class="status-badge ${statusClass}"><span style="flex-shrink:0;">${displayStatus}</span></span>`;
};

const ColumnDefinitions = [
    {
        id: 'checkbox',
        render: (row, isSelected) => `<td><input type="checkbox" class="row-checkbox" ${isSelected ? 'checked' : ''} data-sku="${row.sku}" aria-label="Select ${row.sku}"></td>`
    },
    {
        id: 'conflict',
        render: (row) => `<td style="text-align: center;">
            ${row.hasError ? `
            <div class="conflict-wrapper" style="position: relative; display: inline-block;">
                <i data-lucide="alert-circle" fill="#A12626" color="white" style="width: 16px; height: 16px; display:inline-block; cursor:pointer;"></i>
                <div class="conflict-popover">
                    <div class="conflict-title">3 conflicts found</div>
                    <div class="conflict-actions">
                        <button class="btn-conflict-view" data-sku="${row.sku}">View conflicts</button>
                        <button class="btn-conflict-dismiss" data-sku="${row.sku}">Dismiss</button>
                    </div>
                </div>
            </div>
            ` : ''}
        </td>`
    },
    {
        id: 'status',
        render: (row) => `<td class="status-cell" data-sku="${row.sku}" style="cursor: pointer;">${buildStatusBadge(row)}</td>`
    },
    { id: 'bu', render: row => `<td>${escapeHtml(row.bu)}</td>` },
    { id: 'customer', render: row => `<td>${escapeHtml(row.customer || '-')}</td>` },
    { id: 'vendor', render: row => `<td>${escapeHtml(row.vendor)}</td>` },
    { id: 'sku', render: row => `<td>${escapeHtml(row.sku)}</td>` },
    { id: 'upc', render: row => `<td>${escapeHtml(row.upc || '-')}</td>` },
    {
        id: 'gtin_kebab',
        render: (row) => `<td style="position: relative;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <span>${escapeHtml(row.gtin)}</span>
                <div class="kebab-dropdown">
                    <button class="btn-kebab" data-sku="${row.sku}" title="Row Actions" style="margin-left: 8px;">
                        <i data-lucide="more-vertical" style="width:16px; height:16px;"></i>
                    </button>
                    <div class="dropdown-menu" style="right: 0; left: auto; top: 100%; margin-top: 4px; min-width: 140px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);">
                        <div class="dropdown-item">View</div>
                        <div class="dropdown-item">Edit</div>
                        <div class="dropdown-item">Dismiss</div>
                        <div class="dropdown-item has-submenu" style="border-top: 1px solid var(--border); margin-top: 4px; padding-top: 8px;">
                            <span>Status</span><i data-lucide="chevron-right" style="width:14px;height:14px;color:#6b7280;"></i>
                            <div class="dropdown-submenu" style="right: 100%; left: auto; top: 0; margin-right: 4px;">
                                <div class="submenu-item-unselected">Pipeline</div>
                                <div class="submenu-item-unselected">Pre-launch</div>
                                <div class="submenu-item-unselected">Active</div>
                                <div class="submenu-item-unselected">Hub Active</div>
                                <div class="submenu-item-unselected">LTO</div>
                                <div class="submenu-item-unselected">UPC Changes</div>
                                <div class="submenu-item-unselected">Discontinuing</div>
                                <div class="submenu-item-unselected">DISCO</div>
                                <div class="submenu-item-unselected">Unknown</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </td>`
    },
    { id: 'title', render: row => `<td title="${escapeHtml(row.title)}">${escapeHtml(row.title.substring(0, 50))}</td>` },
    {
        id: 'tags',
        render: row => {
            if (!row.tags || row.tags.length === 0) return '<td style="vertical-align:middle;">-</td>';
            
            const maxVisible = 2;
            let chipsHtml = '';

            for (let i = 0; i < Math.min(row.tags.length, maxVisible); i++) {
                const tag = TagManager.getTag(row.tags[i]);
                if (!tag) continue;

                chipsHtml += `<span class="tag-chip-table" style="display:inline-flex; align-items:center; border:1px solid #BAE6FD; padding:2px 10px; border-radius:999px; font-size:11px; margin-right:4px; margin-bottom:2px; white-space:nowrap; background:#E0F2FE; color:#0369A1;">
                    ${escapeHtml(tag.label)}
                </span>`;
            }

            if (row.tags.length > maxVisible) {
                const hiddenCount = row.tags.length - maxVisible;
                const hiddenTagsHtml = row.tags.slice(maxVisible).map(tId => {
                    const t = TagManager.getTag(tId);
                    return t ? escapeHtml(t.label) : '';
                }).filter(Boolean).join('<br>');

                chipsHtml += `<span class="has-tooltip" style="display:inline-flex; align-items:center; background:#BAE6FD; color:#0369A1; border:1px solid #7DD3FC; padding:2px 8px; border-radius:999px; font-size:11px; margin-bottom:2px; font-weight:600; cursor:help;">
                    +${hiddenCount}
                    <div class="tooltip-content" style="font-size:12px; padding:6px 10px; text-align:left; z-index:10000; white-space:nowrap; top:-10px; left:100%; transform:translateY(-100%);">
                        ${hiddenTagsHtml}
                    </div>
                </span>`;
            }

            return `<td style="max-width:200px; white-space:normal; padding: 4px 12px; vertical-align:middle;">${chipsHtml}</td>`;
        }
    },
    { id: 'vol', render: row => `<td>${escapeHtml(row.vol)}</td>` },
    { id: 'packType', render: row => `<td>${escapeHtml(row.packType)}</td>` },
    { id: 'packCount', render: row => `<td>${escapeHtml(row.packCount)}</td>` },
    { id: 'brand', render: row => `<td>${escapeHtml(row.brand)}</td>` },
    { id: 'subBrand', render: row => `<td>${escapeHtml(row.subBrand)}</td>` },
    { id: 'region', render: row => `<td>${buildRegionChips(row.regions || row.region)}</td>` },
    { id: 'category', render: row => `<td>${escapeHtml(row.category || '')}</td>` },
    { id: 'subCategory', render: row => `<td>${escapeHtml(row.subCategory || '')}</td>` },
    { id: 'form', render: row => `<td>${escapeHtml(row.form || '')}</td>` },
    { id: 'unitCost', render: row => `<td style="text-align:right;">${formatDollar(row.unitCost)}</td>` },
    { id: 'srp', render: row => `<td style="text-align:right;">${formatDollar(row.srp)}</td>` },
    { id: 'cogs', render: row => `<td style="text-align:right;">${formatDollar(row.cogs)}</td>` },
    { id: 'rsvPy', render: row => `<td style="text-align:right;">${formatDollar(row.rsvPy)}</td>` },
    { id: 'rsvYtd', render: row => `<td style="text-align:right;">${formatDollar(row.rsvYtd)}</td>` },
    { id: 'rsvFinancePackSize2024', render: row => `<td style="text-align:right;">${formatDollar(row.rsvPy)}</td>` },
    { id: 'resetDate', render: row => {
        const isDisco = DataStore.state.filters.view === 'disco';
        return `<td>${escapeHtml(isDisco ? (row.discoDate || '-') : (row.resetDate || '-'))}</td>`;
    }},
    { id: 'inMarketDate', render: row => `<td>${escapeHtml(row.inMarketDate)}</td>` },
    { id: 'lastUpdated', render: row => `<td><span class="audit-trail-link" data-sku="${escapeHtml(row.sku)}" style="color:#2185F4; font-weight:500; cursor:pointer; text-decoration:none; white-space:nowrap;" title="View Audit Trail">${escapeHtml(row.lastUpdated)}</span></td>` }
];

// UPC Changes specific columns
const UpcColumnDefinitions = [
    {
        id: 'checkbox',
        render: (row, isSelected) => `<td><input type="checkbox" class="row-checkbox" ${isSelected ? 'checked' : ''} data-sku="${row.sku}" aria-label="Select ${row.sku}"></td>`
    },
    {
        id: 'conflict',
        render: (row) => `<td style="text-align: center;">
            ${row.hasError ? `<i data-lucide="alert-circle" fill="#A12626" color="white" style="width: 16px; height: 16px;"></i>` : ''}
        </td>`
    },
    { id: 'status', render: (row) => `<td class="status-cell" data-sku="${row.sku}" style="cursor: pointer;">${buildStatusBadge(row)}</td>` },
    { id: 'bu', render: row => `<td>${escapeHtml(row.bu)}</td>` },
    { id: 'brand', render: row => `<td>${escapeHtml(row.brand)}</td>` },
    { id: 'title', render: row => `<td title="${escapeHtml(row.title)}">${escapeHtml(row.title.substring(0, 50))}</td>` },
    { id: 'sku', render: row => `<td>${escapeHtml(row.sku)}</td>` },
    { id: 'upcOld', render: row => `<td style="color:#A12626; font-weight:500;">${escapeHtml(row.upcOld || row.upc || '-')}</td>` },
    { id: 'upcNew', render: row => `<td style="color:#008A45; font-weight:500;">${escapeHtml(row.upcNew || '-')}</td>` },
    { id: 'upcChangeDate', render: row => `<td>${escapeHtml(row.upcChangeDate || '-')}</td>` },
    { id: 'upcChangeReason', render: row => `<td>${escapeHtml(row.upcChangeReason || '-')}</td>` },
    { id: 'customer', render: row => `<td>${escapeHtml(row.customer || '-')}</td>` },
    { id: 'vendor', render: row => `<td>${escapeHtml(row.vendor)}</td>` },
    { id: 'lastUpdated', render: row => `<td><span class="audit-trail-link" data-sku="${escapeHtml(row.sku)}" style="color:#2185F4; font-weight:500; cursor:pointer; text-decoration:none; white-space:nowrap;" title="View Audit Trail">${escapeHtml(row.lastUpdated)}</span></td>` }
];

const UpcColumnHeaders = [
    '', '', 'STATUS', 'BU', 'BRAND', 'ITEM TITLE', 'RETAILER SKU',
    'OLD UPC', 'NEW UPC', 'CHANGE DATE', 'REASON', 'CUSTOMER', 'VENDOR CODE', 'LAST UPDATED'
];

// ============================================================================
// UI MANAGER
// ============================================================================
const UIManager = {
    renderTable() {
        try {
            const tbody = document.getElementById('table-body');
            const thead = document.querySelector('table thead tr');
            if (!tbody) return;

            const isUpcView = DataStore.state.filters.view === 'upc';
            const columns = isUpcView ? UpcColumnDefinitions : ColumnDefinitions;

            // Swap table headers for UPC view
            if (thead) {
                if (isUpcView) {
                    thead.innerHTML = UpcColumnHeaders.map(h => {
                        if (!h) return '<th></th>';
                        return `<th><div style="display:flex; align-items:center;">${h} <i data-lucide="chevrons-up-down" style="width:12px; height:12px; margin-left:4px; opacity:0.4;"></i></div></th>`;
                    }).join('');
                } else if (thead.dataset.view === 'upc') {
                    // Restore original headers — reload from stored
                    thead.innerHTML = thead.dataset.originalHtml || '';
                }
                // Store original headers on first render
                if (!thead.dataset.originalHtml && !isUpcView) {
                    thead.dataset.originalHtml = thead.innerHTML;
                }
                thead.dataset.view = isUpcView ? 'upc' : 'default';
            }

            tbody.innerHTML = '';
            const dataToRender = DataAccessor.getFilteredData();
            
            // Pagination implementation
            const paginatedData = PaginationEngine.paginate(
                dataToRender, 
                DataStore.state.pagination.pageSize, 
                DataStore.state.pagination.currentPage
            );

            paginatedData.forEach(row => {
                const tr = document.createElement('tr');
                const isSelected = DataStore.state.selection.has(row.sku);
                
                let innerHtml = '';
                columns.forEach(col => {
                    innerHtml += col.render(row, isSelected);
                });
                
                tr.innerHTML = innerHtml;
                tbody.appendChild(tr);
            });

            if (window.lucide) {
                try { window.lucide.createIcons(); } catch (e) {}
            }

            this.updateItemCount();
            return true;
        } catch (error) {
            console.error('Error rendering table:', error);
            this.showError('Failed to render table');
            return false;
        }
    },

    updateItemCount() {
        const count = DataAccessor.getFilteredCount();
        const countEl = document.querySelector('.items-count');
        if (countEl) countEl.textContent = `${count} ${count === 1 ? 'ASIN' : 'ASINs'}`;
    },

    showError(message) {
        console.error(message);
        const alert = document.createElement('div');
        alert.style.cssText = `position: fixed; bottom: 20px; right: 20px; background: #EF4444; color: white; padding: 12px 16px; border-radius: 4px; z-index: 9999; font-size: 13px;`;
        alert.textContent = message;
        document.body.appendChild(alert);
        setTimeout(() => alert.remove(), 5000);
    },

    updateStatusDropdownCounts() {
        const counts = {};
        DataStore.state.items.forEach(item => {
            const s = (item.status === 'Discontinued' || item.status === 'discontinued') ? 'disco' : item.status.toLowerCase();
            counts[s] = (counts[s] || 0) + 1;
        });

        // Map dropdown labels to data status values
        const labelToStatus = {
            'pipeline': 'pipeline',
            'pre-launch': 'pre-launch',
            'active': 'active',
            'hub active': 'hub-active',
            'lto': 'lto',
            'upc changes': 'upc-changes',
            'discontinuing': 'discontinuing',
            'disco': 'disco',
            'unknown - review': 'unknown',
        };

        const statusFilter = document.querySelector('[data-filter="statusFilter"]');
        if (!statusFilter) return;

        const items = statusFilter.querySelectorAll('.dropdown-item span');
        items.forEach(span => {
            const textNode = Array.from(span.childNodes).find(n => n.nodeType === 3 && n.textContent.trim().length > 0);
            if (textNode) {
                const text = textNode.textContent.trim();
                const match = text.match(/^(.*?)\s*\(\d+\)$/);
                if (match) {
                    const name = match[1];
                    const statusKey = labelToStatus[name.toLowerCase()] || name.toLowerCase();
                    const count = counts[statusKey] || 0;
                    textNode.textContent = ` ${name} (${count})`;
                }
            }
        });
    },

    updateUI() {
        this.updateStatusDropdownCounts();
        this.updateTagFilterDropdown();
        // Swap Reset Date / Disco Date header based on view
        const resetHeader = document.querySelector('th:has(div)');
        const allHeaders = document.querySelectorAll('th div');
        allHeaders.forEach(div => {
            if (div.textContent.trim().startsWith('RESET DATE') || div.textContent.trim().startsWith('DISCO DATE')) {
                const icon = div.querySelector('i');
                const isDisco = DataStore.state.filters.view === 'disco';
                div.innerHTML = '';
                div.textContent = isDisco ? 'DISCO DATE ' : 'RESET DATE ';
                if (icon) div.appendChild(icon);
                else {
                    const i = document.createElement('i');
                    i.dataset.lucide = 'chevrons-up-down';
                    i.style.cssText = 'width:12px; height:12px; margin-left:4px; opacity:0.4;';
                    div.appendChild(i);
                }
            }
        });
        this.renderTable();
        if (window.lucide) try { lucide.createIcons(); } catch(e) {}
    },

    updateTagFilterDropdown() {
        const menu = document.getElementById('tagFilterMenu');
        if (!menu) return;
        const mixedItem = menu.querySelector('.mixed-item');
        Array.from(menu.children).forEach(child => {
            if (child !== mixedItem) child.remove();
        });
        TagManager.getTags().forEach(tag => {
            const item = document.createElement('div');
            item.className = 'dropdown-item';
            item.innerHTML = `<span>${escapeHtml(tag.label)}</span><i data-lucide="check" class="check-icon"></i>`;
            item.dataset.tagId = tag.id;
            menu.appendChild(item);
        });
        if (window.lucide) try { lucide.createIcons(); } catch(e) {}
    },
    
    escapeHtml(text) { return escapeHtml(text); }
};

// ============================================================================
// EVENT HANDLER
// ============================================================================
const EventHandler = {
    init() {
        this.initSearchFilter();
        this.initCustomDropdowns();
        this.initSideDrawer();
        this.initTableInteractions();
        this.initBulkActions();
        this.initPageSizeControl();
        this.initSegmentControl();
    },

    initSegmentControl() {
        const buttons = document.querySelectorAll('.segmented-btn');
        buttons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                buttons.forEach(b => b.classList.remove('active'));
                const target = e.currentTarget;
                target.classList.add('active');
                DataStore.setFilters({ view: target.dataset.view });
                UIManager.updateUI();
            });
        });
    },

    initPageSizeControl() {
        const select = document.querySelector('.page-size-select');
        if (select) {
            select.value = DataStore.state.pagination.pageSize;
            select.addEventListener('change', (e) => {
                DataStore.state.pagination.pageSize = parseInt(e.target.value, 10);
                DataStore.state.pagination.currentPage = 1; // reset page on size change
                UIManager.updateUI();
            });
        }
    },

    initSearchFilter() {
        const searchInput = document.querySelector('.search-box input');
        if (!searchInput) return;
        let debounceTimer;
        searchInput.addEventListener('input', (e) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                DataStore.setFilters({ searchTerm: e.target.value });
                UIManager.updateUI();
            }, 300);
        });
    },

    initCustomDropdowns() {
        const dropdowns = document.querySelectorAll('.filter-dropdown');
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.filter-dropdown')) dropdowns.forEach(d => d.classList.remove('open'));
            if (!e.target.closest('.kebab-dropdown')) document.querySelectorAll('.kebab-dropdown').forEach(d => d.classList.remove('open'));
        });

        dropdowns.forEach(dropdown => {
            const trigger = dropdown.querySelector('.dropdown-trigger');
            if (!trigger) return;
            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                dropdowns.forEach(d => { if (d !== dropdown) d.classList.remove('open'); });
                dropdown.classList.toggle('open');
            });

            const isMulti = dropdown.classList.contains('multi-select');
            const items = dropdown.querySelectorAll('.dropdown-item');
            const mixedItem = dropdown.querySelector('.mixed-item');
            const otherItems = Array.from(items).filter(item => item !== mixedItem && !item.textContent.trim().toLowerCase().startsWith('all'));

            items.forEach(item => {
                item.addEventListener('click', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    if (!isMulti) {
                        items.forEach(sibling => sibling.classList.remove('active'));
                        item.classList.add('active');
                        dropdown.classList.remove('open');
                    } else {
                        const isMixed = item === mixedItem || item.textContent.trim().toLowerCase().startsWith('all');
                        if (isMixed) {
                            otherItems.forEach(sibling => sibling.classList.remove('active'));
                            item.classList.add('active');
                        } else {
                            item.classList.toggle('active');
                            if (item.classList.contains('active') && mixedItem) mixedItem.classList.remove('active');
                            if (otherItems.every(i => !i.classList.contains('active')) && mixedItem) mixedItem.classList.add('active');
                        }
                    }
                    if (item.classList.contains('has-submenu') || item.closest('.dropdown-submenu')) return;
                    EventHandler.onFilterCheckboxChange(dropdown);
                });
            });
            EventHandler.onFilterCheckboxChange(dropdown);
        });
    },

    onFilterCheckboxChange(dropdown) {
        const triggerSpan = dropdown.querySelector('.dropdown-trigger span');
        if (!triggerSpan) return;
        const filterKey = dropdown.dataset.filter;
        let selected = [];
        const isMulti = dropdown.classList.contains('multi-select');
        const activeItems = Array.from(dropdown.querySelectorAll('.dropdown-item.active'));
        const mixedItem = dropdown.querySelector('.mixed-item');
        
        if (isMulti) {
            if (activeItems.includes(mixedItem)) selected = [];
            else selected = activeItems.map(item => item.textContent.trim());
            
            if (selected.length === 0) triggerSpan.textContent = mixedItem ? mixedItem.textContent.trim() : "All";
            else if (selected.length === 1) triggerSpan.textContent = selected[0];
            else triggerSpan.textContent = selected.length + " selected";
        } else {
            const activeItem = activeItems[0];
            if (activeItem) {
                let text = activeItem.textContent.trim();
                triggerSpan.textContent = text;
                if (text.toLowerCase().startsWith('all')) selected = [];
                else selected = [text.split('(')[0].trim()];
            }
        }
        if (filterKey) {
            // Special handling for tag filter - use tag IDs instead of text
            if (filterKey === 'tagFilter') {
                const tagSelected = [];
                if (!activeItems.includes(mixedItem) || !mixedItem) {
                    activeItems.forEach(item => {
                        if (item.dataset.tagId) tagSelected.push(item.dataset.tagId);
                    });
                }
                DataStore.setFilters({ tagFilter: tagSelected });
            } else {
                DataStore.setFilters({ [filterKey]: selected });
            }
            UIManager.updateUI();
        }
    },

    initSideDrawer() {
        const drawerOverlay = document.getElementById('drawerOverlay');
        const drawer = document.getElementById('productDrawer');
        const closeBtn = document.getElementById('closeDrawerBtn');
        const cancelBtn = document.getElementById('cancelDrawerBtn');

        if (!drawer || !drawerOverlay) return;
        const closeDrawer = () => {
            drawer.classList.remove('open');
            setTimeout(() => drawerOverlay.classList.remove('active'), 300);
        };
        closeBtn?.addEventListener('click', closeDrawer);
        cancelBtn?.addEventListener('click', closeDrawer);
        drawerOverlay?.addEventListener('click', closeDrawer);
    },

    initTableInteractions() {
        const headerToggle = document.querySelector('.header-toggle input');
        if (headerToggle) {
            DataStore.setFilters({ hasError: headerToggle.checked });
            headerToggle.addEventListener('change', (e) => {
                DataStore.setFilters({ hasError: e.target.checked });
                UIManager.updateUI();
            });
        }
        
        const headers = document.querySelectorAll('th');
        const columnMap = {
            'STATUS': 'status', 'BU': 'bu', 'CUSTOMER': 'customer', 'VENDOR CODE': 'vendor', 'RETAILER SKU': 'sku',
            'GTIN': 'gtin', 'ITEM TITLE': 'title', 'TAGS': 'tags', 'SIZE CATEGORY': 'vol', 'FINANCE PACK SIZE': 'packType',
            'PACK COUNT': 'packCount', 'BRAND': 'brand', 'SUB-BRAND': 'subBrand', 'REGION': 'region',
            'CATEGORY': 'category', 'SUB-CATEGORY': 'subCategory', 'FORM': 'form',
            'UNIT COST': 'unitCost', 'SRP': 'srp', 'CASE COST': 'cogs',
            '2024 FY RSV': 'rsvPy', 'YTD RSV': 'rsvYtd', '2024 RSV': 'rsvPy',
            'RESET DATE': 'resetDate', 'DISCO DATE': 'discoDate', 'IN MARKET DATE': 'inMarketDate', 'LAST UPDATED': 'lastUpdated'
        };

        headers.forEach(th => {
            th.addEventListener('click', () => {
                if (th.querySelector('input[type="checkbox"]') || th.querySelector('.header-toggle')) return;
                const text = th.textContent.trim().toUpperCase();
                const key = columnMap[text];
                if (!key) return;

                let direction = 'asc';
                if (DataStore.state.filters.sortKey === key) {
                    direction = DataStore.state.filters.sortDirection === 'asc' ? 'desc' : 'asc';
                }

                headers.forEach(h => {
                    const icon = h.querySelector('i');
                    if (icon) {
                        icon.setAttribute('data-lucide', 'chevrons-up-down');
                        icon.style.opacity = '0.4';
                    }
                });

                const clickedIcon = th.querySelector('i');
                if (clickedIcon) {
                    clickedIcon.setAttribute('data-lucide', direction === 'asc' ? 'chevron-up' : 'chevron-down');
                    clickedIcon.style.opacity = '1';
                    if (window.lucide) window.lucide.createIcons();
                }

                DataStore.setSorting(key, direction);
                UIManager.updateUI();
            });
        });

        document.getElementById('table-body')?.addEventListener('click', (e) => {
            const statusCell = e.target.closest('.status-cell');
            if (statusCell) {
                const sku = statusCell.dataset.sku;
                const row = DataStore.state.items.find(item => item.sku === sku);
                if (row) this.openProductDrawer(row, 'view');
            }

            const checkbox = e.target.closest('.row-checkbox');
            if (checkbox) {
                const sku = checkbox.dataset.sku;
                DataStore.toggleSelection(sku);
                checkbox.checked = DataStore.state.selection.has(sku);
            }

            const auditLink = e.target.closest('.audit-trail-link');
            if (auditLink) {
                const sku = auditLink.dataset.sku;
                const row = DataStore.state.items.find(item => item.sku === sku);
                if (row) this.openAuditTrailDrawer(row);
                return;
            }

            const viewConflictsBtn = e.target.closest('.btn-conflict-view');
            if (viewConflictsBtn) {
                const sku = viewConflictsBtn.dataset.sku;
                const row = DataStore.state.items.find(item => item.sku === sku);
                if (row) this.openConflictDrawer(row);
            }

            const dismissConflictBtn = e.target.closest('.btn-conflict-dismiss');
            if (dismissConflictBtn) {
                const sku = dismissConflictBtn.dataset.sku;
                const row = DataStore.state.items.find(item => item.sku === sku);
                if (row) {
                    row.hasError = false;
                    UIManager.updateUI();
                }
            }

            const kebabBtn = e.target.closest('.btn-kebab');
            if (kebabBtn) {
                e.stopPropagation();
                const parent = kebabBtn.parentElement;
                const menu = parent.querySelector('.dropdown-menu');
                
                document.querySelectorAll('.kebab-dropdown').forEach(d => {
                    if (d !== parent) {
                        d.classList.remove('open');
                        const otherMenu = d.querySelector('.dropdown-menu');
                        if (otherMenu) {
                            otherMenu.style.position = '';
                            otherMenu.style.top = '';
                            otherMenu.style.left = '';
                        }
                    }
                });

                const isOpen = parent.classList.toggle('open');
                if (isOpen && menu) {
                    // Position Fixed approach to avoid clipping
                    const rect = kebabBtn.getBoundingClientRect();
                    menu.style.position = 'fixed';
                    menu.style.top = `${rect.bottom + 4}px`;
                    menu.style.left = `${rect.right - 140}px`;
                    menu.style.right = 'auto';
                    menu.style.zIndex = '9999';
                } else if (menu) {
                    menu.style.position = '';
                    menu.style.top = '';
                    menu.style.left = '';
                }
            }

            // Handle View / Edit dropdown items in kebab menu
            const dropdownItem = e.target.closest('.dropdown-item');
            if (dropdownItem && dropdownItem.closest('.kebab-dropdown') && !dropdownItem.classList.contains('has-submenu')) {
                const action = dropdownItem.textContent.trim();
                const sku = dropdownItem.closest('.kebab-dropdown').querySelector('.btn-kebab').dataset.sku;
                const row = DataStore.state.items.find(item => item.sku === sku);
                if (row && (action === 'View' || action === 'Edit')) {
                    document.querySelectorAll('.kebab-dropdown').forEach(d => d.classList.remove('open'));
                    this.openProductDrawer(row, action === 'View' ? 'view' : 'edit');
                    return;
                }
            }

            const kebabItem = e.target.closest('.submenu-item-unselected');
            if (kebabItem && kebabItem.closest('.kebab-dropdown')) {
                const newStatus = kebabItem.textContent.trim();
                const sku = kebabItem.closest('.kebab-dropdown').querySelector('.btn-kebab').dataset.sku;
                const row = DataStore.state.items.find(item => item.sku === sku);
                
                if (row) {
                    // Map display label to internal status value
                    const statusMap = {
                        'Pipeline': 'pipeline',
                        'Pre-launch': 'pre-launch',
                        'Active': 'active',
                        'Hub Active': 'hub-active',
                        'LTO': 'lto',
                        'UPC Changes': 'upc-changes',
                        'Discontinuing': 'discontinuing',
                        'DISCO': 'discontinued',
                        'Discontinued': 'discontinued',
                        'Unknown': 'unknown',
                    };
                    const statusClassMap = {
                        'pipeline': 'pipeline',
                        'pre-launch': 'prelaunch',
                        'active': 'active',
                        'hub-active': 'hubactive',
                        'lto': 'lto',
                        'upc-changes': 'upcchanges',
                        'discontinuing': 'discontinuing',
                        'discontinued': 'discontinued',
                        'unknown': 'unknown',
                    };
                    const mappedStatus = statusMap[newStatus] || newStatus.toLowerCase();
                    row.status = mappedStatus;
                    row.statusClass = statusClassMap[mappedStatus] || mappedStatus;
                    
                    document.querySelectorAll('.kebab-dropdown').forEach(d => d.classList.remove('open'));
                    
                    if (mappedStatus === 'discontinued') {
                        document.querySelectorAll('.segmented-btn').forEach(b => b.classList.remove('active'));
                        const discoBtn = document.querySelector('.segmented-btn[data-view="disco"]');
                        if (discoBtn) discoBtn.classList.add('active');
                        DataStore.setFilters({ view: 'disco' });
                    }
                    UIManager.updateUI();
                    updateKPIs();
                }
            }
        });

        const closeDropdowns = () => {
            document.querySelectorAll('.kebab-dropdown').forEach(d => {
                d.classList.remove('open');
                const menu = d.querySelector('.dropdown-menu');
                if (menu) {
                    menu.style.position = '';
                    menu.style.top = '';
                    menu.style.left = '';
                }
            });
        };
        const tableContainer = document.querySelector('.table-container');
        if (tableContainer) tableContainer.addEventListener('scroll', closeDropdowns, { passive: true });
        window.addEventListener('scroll', closeDropdowns, { passive: true });
    },

    openConflictDrawer(product) {
        let drawer = document.getElementById('conflictDrawer');
        let drawerOverlay = document.getElementById('drawerOverlay');

        if (!drawer) {
            drawer = document.createElement('div');
            drawer.id = 'conflictDrawer';
            drawer.className = 'side-drawer';
            drawer.innerHTML = `
                <div class="drawer-header" style="border-bottom: 1px solid #E5E7EB; padding: 24px;">
                    <h2 id="conflictDrawerTitle" style="font-size: 16px; font-weight: 700; color: #111827;"></h2>
                    <button class="close-drawer" onclick="document.getElementById('conflictDrawer').classList.remove('open'); setTimeout(()=>document.getElementById('drawerOverlay').classList.remove('active'), 300);"><i data-lucide="x" style="width:20px;height:20px;color:#6B7280;"></i></button>
                </div>
                <div class="drawer-content" id="conflictDrawerContent" style="background-color: #ffffff; padding: 24px; flex: 1; overflow-y: auto;"></div>
                <div class="drawer-footer" style="padding: 16px 24px; border-top: 1px solid #E5E7EB; display: flex; gap: 12px; background: #F9FAFB;">
                    <button class="btn btn-secondary" onclick="document.getElementById('conflictDrawer').classList.remove('open'); setTimeout(()=>document.getElementById('drawerOverlay').classList.remove('active'), 300);" style="flex: 1; font-weight: 600; padding: 12px; background: #E5E7EB; border: none; color: #374151; border-radius: 4px; cursor: pointer; text-align: center;">Cancel</button>
                    <button class="btn btn-primary" onclick="document.getElementById('conflictDrawer').classList.remove('open'); setTimeout(()=>document.getElementById('drawerOverlay').classList.remove('active'), 300);" style="flex: 1; font-weight: 600; padding: 12px; background: #2185F4; border: none; color: white; border-radius: 4px; cursor: pointer; text-align: center;">Save</button>
                </div>
            `;
            document.body.appendChild(drawer);
            if (window.lucide) window.lucide.createIcons();
        }

        const title = document.getElementById('conflictDrawerTitle');
        if (title) title.textContent = `${product.sku} suggestions`;

        const content = document.getElementById('conflictDrawerContent');
        if (content) {
            content.innerHTML = `
                <div style="margin-bottom: 24px;">
                    <label style="display:block; font-size:12px; color:#4B5563; margin-bottom:8px;">GTIN</label>
                    <div class="input-group" style="padding: 10px 12px;">
                        <span style="color: #374151;">${escapeHtml(product.gtin)}</span>
                        <div class="input-group-icons">
                            <i data-lucide="x" style="width:16px;height:16px;"></i>
                            <i data-lucide="chevron-down" style="width:16px;height:16px;"></i>
                        </div>
                    </div>
                </div>
                <div style="margin-bottom: 24px;">
                    <label style="display:block; font-size:12px; color:#4B5563; margin-bottom:8px;">Pack count</label>
                    <div class="input-group" style="padding: 10px 12px;">
                        <span style="color: #374151;">${escapeHtml(product.packCount)} pack</span>
                        <div class="input-group-icons">
                            <i data-lucide="x" style="width:16px;height:16px;"></i>
                            <i data-lucide="chevron-down" style="width:16px;height:16px;"></i>
                        </div>
                    </div>
                    <div class="suggestion-box" style="margin-top: 12px;">
                        <div class="suggestion-text">
                            <i data-lucide="lightbulb" class="bulb-icon"></i>
                            <span style="color:#6B7280; font-style:italic; margin-right:4px;">Suggestion:</span> 
                            <span style="font-weight:600; color: #111827;">6</span> <span style="color: #111827;">pack</span>
                        </div>
                        <div class="suggestion-actions">
                            <button class="btn-accept">Accept</button>
                            <button class="btn-dismiss-text">Dismiss</button>
                        </div>
                    </div>
                </div>
            `;
            if (window.lucide) window.lucide.createIcons();
        }
        drawerOverlay?.classList.add('active');
        setTimeout(() => drawer?.classList.add('open'), 10);
    },

    openAuditTrailDrawer(product) {
        const drawerOverlay = document.getElementById('drawerOverlay');

        // Reuse or create dedicated audit drawer
        let drawer = document.getElementById('auditTrailDrawer');
        if (!drawer) {
            drawer = document.createElement('div');
            drawer.id = 'auditTrailDrawer';
            drawer.className = 'side-drawer';
            drawer.style.cssText = 'width: 520px;';
            document.body.appendChild(drawer);
        }

        const closeDrawer = () => {
            drawer.classList.remove('open');
            setTimeout(() => drawerOverlay?.classList.remove('active'), 300);
        };

        // Mock audit history per product — keyed by SKU prefix for variety
        const auditActors = ['Aneesh Arora', 'Robert Stribling', 'Vitaly Milyakov', 'Cedric Lyons', 'Maria Lopez', 'James Chen'];
        const auditActions = [
            { event: 'Inactivate for Ship-To', color: '#FEF3C7', textColor: '#92400E' },
            { event: 'Activate for Ship-To',   color: '#D1FAE5', textColor: '#065F46' },
            { event: 'Update Product',          color: '#DBEAFE', textColor: '#1E40AF' },
            { event: 'Delete Product',          color: '#FEE2E2', textColor: '#991B1B' },
            { event: 'Add Product',             color: '#EDE9FE', textColor: '#5B21B6' },
            { event: 'Status Changed',          color: '#DBEAFE', textColor: '#1E40AF' },
        ];

        // Generate 4–6 deterministic-ish entries from the product's own data
        const seed = (product.id || 1);
        const generateEntries = () => {
            const entries = [];
            const count = 4 + (seed % 3); // 4, 5, or 6 entries
            const now = new Date('2026-05-13T08:59:00');
            for (let i = 0; i < count; i++) {
                const actionIdx  = (seed + i * 3) % auditActions.length;
                const actorIdx   = (seed + i * 2) % auditActors.length;
                const daysBack   = i === 0 ? 0 : i * 18 + (seed % 15);
                const ts = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
                const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                const hh = ts.getHours();
                const mm = String(ts.getMinutes()).padStart(2,'0');
                const ampm = hh >= 12 ? 'pm' : 'am';
                const h12 = hh % 12 || 12;
                const dateStr = `${months[ts.getMonth()]} ${ts.getDate()} ${ts.getFullYear()}, ${h12}:${mm} ${ampm}`;
                entries.push({ ...auditActions[actionIdx], actor: auditActors[actorIdx], timestamp: dateStr });
            }
            return entries;
        };

        const entries = generateEntries();
        const truncTitle = product.title && product.title.length > 35
            ? product.title.substring(0, 35) + '…'
            : (product.title || product.sku);

        const rowsHtml = entries.map((entry, i) => `
            <tr style="border-bottom: 1px solid #F3F4F6; ${i % 2 === 0 ? 'background:#FFFFFF;' : 'background:#F9FAFB;'}">
                <td style="padding: 12px 16px; vertical-align: top;">
                    <span style="
                        display: inline-flex; align-items: center; gap: 4px;
                        background: ${entry.color}; color: ${entry.textColor};
                        font-size: 11px; font-weight: 600; padding: 3px 8px;
                        border-radius: 4px; white-space: nowrap;
                    ">
                        ${escapeHtml(entry.event)}
                    </span>
                </td>
                <td style="padding: 12px 16px; vertical-align: top; font-size: 13px; font-weight: 500; color: #111827; white-space: nowrap;">
                    ${escapeHtml(entry.actor)}
                </td>
                <td style="padding: 12px 16px; vertical-align: top; font-size: 12px; color: #6B7280; white-space: nowrap;">
                    ${escapeHtml(entry.timestamp)}
                </td>
            </tr>
        `).join('');

        drawer.innerHTML = `
            <div class="drawer-header" style="background: #1B4DB8; padding: 16px 20px; display: flex; align-items: center; gap: 12px; flex-shrink: 0;">
                <div style="flex: 1; overflow: hidden;">
                    <div style="font-size: 11px; color: rgba(255,255,255,0.7); font-weight: 500; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.5px;">Audit Trail</div>
                    <h2 style="font-size: 14px; font-weight: 700; color: #ffffff; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                        ${escapeHtml(product.sku)}: ${escapeHtml(truncTitle)}
                    </h2>
                </div>
                <button onclick="document.getElementById('auditTrailDrawer').classList.remove('open'); setTimeout(()=>document.getElementById('drawerOverlay').classList.remove('active'), 300);"
                    style="background: rgba(255,255,255,0.15); border: none; color: #fff; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                    ✕
                </button>
            </div>

            <div style="flex: 1; overflow-y: auto; background: #fff;">
                <!-- Product context strip -->
                <div style="padding: 12px 20px; background: #F8FAFF; border-bottom: 1px solid #E5E7EB; display: flex; gap: 24px; flex-wrap: wrap;">
                    <div>
                        <div style="font-size: 10px; color: #9CA3AF; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px;">SKU</div>
                        <div style="font-size: 13px; font-weight: 600; color: #111827;">${escapeHtml(product.sku)}</div>
                    </div>
                    <div>
                        <div style="font-size: 10px; color: #9CA3AF; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px;">GTIN</div>
                        <div style="font-size: 13px; font-weight: 600; color: #111827;">${escapeHtml(product.gtin || '-')}</div>
                    </div>
                    <div>
                        <div style="font-size: 10px; color: #9CA3AF; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px;">Last Updated</div>
                        <div style="font-size: 13px; font-weight: 600; color: #2185F4;">${escapeHtml(product.lastUpdated || '-')}</div>
                    </div>
                    <div>
                        <div style="font-size: 10px; color: #9CA3AF; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px;">Total Events</div>
                        <div style="font-size: 13px; font-weight: 600; color: #111827;">${entries.length}</div>
                    </div>
                </div>

                <!-- Table -->
                <div style="overflow-x: auto;">
                    <table style="width: 100%; border-collapse: collapse;">
                        <thead>
                            <tr style="background: #F9FAFB; border-bottom: 1px solid #E5E7EB;">
                                <th style="padding: 10px 16px; text-align: left; font-size: 11px; font-weight: 700; color: #6B7280; text-transform: uppercase; letter-spacing: 0.5px;">Event</th>
                                <th style="padding: 10px 16px; text-align: left; font-size: 11px; font-weight: 700; color: #6B7280; text-transform: uppercase; letter-spacing: 0.5px;">Actor</th>
                                <th style="padding: 10px 16px; text-align: left; font-size: 11px; font-weight: 700; color: #6B7280; text-transform: uppercase; letter-spacing: 0.5px;">Time (America/Mexico_City)</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rowsHtml}
                        </tbody>
                    </table>
                </div>
            </div>

            <div class="drawer-footer" style="padding: 14px 20px; border-top: 1px solid #E5E7EB; display: flex; justify-content: flex-end; background: #F9FAFB; flex-shrink: 0;">
                <button onclick="document.getElementById('auditTrailDrawer').classList.remove('open'); setTimeout(()=>document.getElementById('drawerOverlay').classList.remove('active'), 300);"
                    style="padding: 8px 20px; border: 1px solid #D1D5DB; border-radius: 6px; background: #fff; font-size: 13px; font-weight: 600; color: #374151; cursor: pointer;">
                    Close
                </button>
            </div>
        `;

        drawerOverlay?.classList.add('active');
        setTimeout(() => drawer?.classList.add('open'), 10);
    },

    openProductDrawer(product, mode = 'view') {
        const drawerContent = document.getElementById('drawerContent');
        const drawer = document.getElementById('productDrawer');
        const drawerOverlay = document.getElementById('drawerOverlay');
        const drawerHeader = drawer?.querySelector('.drawer-header h2');
        const drawerFooter = drawer?.querySelector('.drawer-footer');

        if (!drawerContent || !drawer) return;

        const closeDrawer = () => {
            drawer.classList.remove('open');
            setTimeout(() => drawerOverlay?.classList.remove('active'), 300);
        };

        // -- Header text --
        if (drawerHeader) {
            if (mode === 'view' && product) {
                const truncTitle = product.title.length > 30 ? product.title.substring(0, 30) + '...' : product.title;
                drawerHeader.textContent = `${product.gtin}: ${truncTitle}`;
            } else if (mode === 'edit') {
                drawerHeader.textContent = 'Edit Product';
            } else {
                drawerHeader.textContent = 'New Product';
            }
        }

        // -- Footer buttons --
        if (drawerFooter) {
            if (mode === 'view') {
                drawerFooter.innerHTML = `<button id="cancelDrawerBtn" class="btn-secondary" style="padding:8px 16px; border:1px solid #D1D5DB; border-radius:6px; background:#fff; cursor:pointer;">Close</button>`;
                drawerFooter.querySelector('#cancelDrawerBtn').addEventListener('click', closeDrawer);
            } else if (mode === 'edit') {
                drawerFooter.innerHTML = `
                    <button id="drawerCancelBtn" class="btn-secondary" style="padding:8px 16px; border:1px solid #D1D5DB; border-radius:6px; background:#fff; cursor:pointer;">Cancel</button>
                    <button id="drawerSaveBtn" class="btn-primary" style="padding:8px 16px; border:none; border-radius:6px; background:#2563EB; color:#fff; font-weight:600; cursor:pointer;">Save Changes</button>`;
                drawerFooter.querySelector('#drawerCancelBtn').addEventListener('click', () => {
                    this.openProductDrawer(product, 'view');
                });
                drawerFooter.querySelector('#drawerSaveBtn').addEventListener('click', () => {
                    this._saveProductFromDrawer(product, 'edit');
                    closeDrawer();
                });
            } else {
                drawerFooter.innerHTML = `
                    <button id="drawerCancelBtn" class="btn-secondary" style="padding:8px 16px; border:1px solid #D1D5DB; border-radius:6px; background:#fff; cursor:pointer;">Cancel</button>
                    <button id="drawerCreateBtn" class="btn-primary" style="padding:8px 16px; border:none; border-radius:6px; background:#2563EB; color:#fff; font-weight:600; cursor:pointer;">Create Product</button>`;
                drawerFooter.querySelector('#drawerCancelBtn').addEventListener('click', closeDrawer);
                drawerFooter.querySelector('#drawerCreateBtn').addEventListener('click', () => {
                    this._saveProductFromDrawer(null, 'create');
                    closeDrawer();
                });
            }
        }

        // -- Field definitions --
        const statusOptions = ['Pipeline', 'Pre-launch', 'Active', 'Hub active', 'LTO', 'UPC Changes', 'Discontinuing', 'DISCO', 'Unknown'];
        const buOptions = ['FLNA', 'PBNA', 'QUAKER', 'Other'];
        const customerOptions = ['Amazon.com', 'Amazon Fresh', 'Walmart', 'Catalog'];
        const vendorOptions = ['FRIT1', 'PGTR1', 'PEQF9', 'PEPQU'];
        const packTypeOptions = ['variety pack', 'straight pack', 'multipack', 'single'];
        const regionOptions = ['Central North', 'Central South', 'North', 'North East', 'North West', 'South Metro', 'South Sunbelt', 'West California', 'West Mountain', 'National Delete'];

        const fields = [
            { label: 'GTIN', key: 'gtin', type: 'text' },
            { label: 'Retailer SKU', key: 'sku', type: 'text' },
            { label: 'UPC', key: 'upc', type: 'text' },
            { label: 'Status', key: 'status', type: 'select', options: statusOptions },
            { label: 'BU', key: 'bu', type: 'select', options: buOptions },
            { label: 'Customer', key: 'customer', type: 'select', options: customerOptions },
            { label: 'Vendor Code', key: 'vendor', type: 'select', options: vendorOptions },
            { label: 'Item Title', key: 'title', type: 'textarea' },
            { label: 'Brand', key: 'brand', type: 'text' },
            { label: 'Sub-Brand', key: 'subBrand', type: 'text' },
            { label: 'Category', key: 'category', type: 'text' },
            { label: 'Sub-Category', key: 'subCategory', type: 'text' },
            { label: 'Pack Volume', key: 'vol', type: 'text' },
            { label: 'Pack Type', key: 'packType', type: 'select', options: packTypeOptions },
            { label: 'Pack Count', key: 'packCount', type: 'number' },
            { label: 'Form', key: 'form', type: 'text' },
            { label: 'Unit Cost', key: 'unitCost', type: 'price' },
            { label: 'SRP', key: 'srp', type: 'price' },
            { label: 'Case Cost', key: 'cogs', type: 'price' },
            { label: 'RSV PY', key: 'rsvPy', type: 'price' },
            { label: 'RSV YTD', key: 'rsvYtd', type: 'price' },
            { label: '2024 RSV', key: 'rsvPy', type: 'number' },
            { label: 'Reset Date', key: 'resetDate', type: 'text' },
            { label: 'In-Market Date', key: 'inMarketDate', type: 'text' },
            { label: 'Region', key: 'region', type: 'multiselect', options: regionOptions },
        ];

        const labelStyle = 'display:block; font-size:12px; font-weight:600; color:#6B7280; margin-bottom:4px; text-transform:uppercase;';
        const valueStyle = 'font-size:14px; font-weight:500; color:#111827;';
        const inputStyle = 'width:100%; padding:8px 10px; border:1px solid #D1D5DB; border-radius:6px; font-size:14px; color:#111827; box-sizing:border-box;';

        const isEditable = mode === 'edit' || mode === 'create';
        const val = (key) => product ? (product[key] ?? '') : '';

        let html = '';

        if (mode === 'view') {
            html += `<div style="margin-bottom:16px; text-align:right;">
                <button id="drawerEditBtn" style="padding:6px 14px; border:1px solid #D1D5DB; border-radius:6px; background:#fff; font-size:13px; font-weight:600; color:#2563EB; cursor:pointer;">Edit</button>
            </div>`;
        }

        fields.forEach(f => {
            html += `<div style="margin-bottom:20px;">`;
            html += `<label style="${labelStyle}">${escapeHtml(f.label)}</label>`;

            if (!isEditable) {
                // VIEW mode
                let displayVal = val(f.key);
                if (f.key === 'region' && Array.isArray(displayVal)) {
                    displayVal = displayVal.join(', ');
                }
                if (f.type === 'price' && displayVal !== '') {
                    displayVal = '$' + String(displayVal).replace(/[$,]/g, '');
                }
                html += `<div style="${valueStyle}">${escapeHtml(String(displayVal))}</div>`;
            } else if (f.type === 'textarea') {
                html += `<textarea data-field="${f.key}" style="${inputStyle} min-height:60px; resize:vertical;">${escapeHtml(String(val(f.key)))}</textarea>`;
            } else if (f.type === 'select') {
                const curVal = String(val(f.key));
                html += `<select data-field="${f.key}" style="${inputStyle}">`;
                html += `<option value="">-- Select --</option>`;
                f.options.forEach(opt => {
                    const selected = opt === curVal ? ' selected' : '';
                    html += `<option value="${escapeHtml(opt)}"${selected}>${escapeHtml(opt)}</option>`;
                });
                html += `</select>`;
            } else if (f.type === 'multiselect') {
                const curArr = Array.isArray(val(f.key)) ? val(f.key) : [];
                html += `<div data-field="${f.key}" data-type="multiselect" style="border:1px solid #D1D5DB; border-radius:6px; padding:8px 10px; max-height:180px; overflow-y:auto;">`;
                f.options.forEach(opt => {
                    const checked = curArr.includes(opt) ? ' checked' : '';
                    html += `<label style="display:flex; align-items:center; gap:6px; padding:3px 0; font-size:13px; color:#111827; cursor:pointer;">
                        <input type="checkbox" value="${escapeHtml(opt)}"${checked} style="accent-color:#2563EB;"> ${escapeHtml(opt)}
                    </label>`;
                });
                html += `</div>`;
            } else if (f.type === 'price') {
                const rawVal = String(val(f.key)).replace(/[$,]/g, '');
                html += `<div style="position:relative;">
                    <span style="position:absolute; left:10px; top:50%; transform:translateY(-50%); color:#6B7280; font-size:14px;">$</span>
                    <input type="text" data-field="${f.key}" data-type="price" value="${escapeHtml(rawVal)}" style="${inputStyle} padding-left:22px;">
                </div>`;
            } else if (f.type === 'number') {
                html += `<input type="number" data-field="${f.key}" value="${escapeHtml(String(val(f.key)))}" style="${inputStyle}">`;
            } else {
                html += `<input type="text" data-field="${f.key}" value="${escapeHtml(String(val(f.key)))}" style="${inputStyle}">`;
            }

            html += `</div>`;
        });

        drawerContent.innerHTML = html;

        // Wire edit button in view mode
        if (mode === 'view') {
            const editBtn = drawerContent.querySelector('#drawerEditBtn');
            if (editBtn) {
                editBtn.addEventListener('click', () => {
                    this.openProductDrawer(product, 'edit');
                });
            }
        }

        drawerOverlay?.classList.add('active');
        setTimeout(() => drawer?.classList.add('open'), 10);
    },

    _saveProductFromDrawer(existingProduct, mode) {
        const drawerContent = document.getElementById('drawerContent');
        if (!drawerContent) return;

        const newData = {};

        // Collect simple inputs, textareas, selects
        drawerContent.querySelectorAll('[data-field]').forEach(el => {
            const key = el.dataset.field;
            if (el.dataset.type === 'multiselect') {
                const checked = el.querySelectorAll('input[type="checkbox"]:checked');
                newData[key] = Array.from(checked).map(cb => cb.value);
            } else if (el.dataset.type === 'price') {
                const raw = el.value.replace(/[$,]/g, '').trim();
                newData[key] = raw === '' ? '' : raw;
            } else if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                newData[key] = el.value;
            }
        });

        if (mode === 'edit' && existingProduct) {
            const idx = DataStore.state.items.findIndex(item => item.sku === existingProduct.sku);
            if (idx !== -1) {
                // Map display status to internal value before saving
                const statusDisplayToInternal = {
                    'Pipeline': 'pipeline', 'Pre-launch': 'pre-launch', 'Active': 'active',
                    'Hub active': 'hub-active', 'Hub Active': 'hub-active', 'LTO': 'lto',
                    'UPC Changes': 'upc-changes', 'Discontinuing': 'discontinuing',
                    'DISCO': 'discontinued', 'Unknown': 'unknown',
                };
                const statusClassLookup = {
                    'pipeline': 'pipeline', 'pre-launch': 'prelaunch', 'active': 'active',
                    'hub-active': 'hubactive', 'lto': 'lto', 'upc-changes': 'upcchanges',
                    'discontinuing': 'discontinuing', 'discontinued': 'discontinued', 'unknown': 'unknown',
                };
                if (newData.status) {
                    newData.status = statusDisplayToInternal[newData.status] || newData.status.toLowerCase();
                }
                Object.assign(DataStore.state.items[idx], newData);
                const s = DataStore.state.items[idx].status;
                DataStore.state.items[idx].statusClass = statusClassLookup[s] || s;
            }
        } else if (mode === 'create') {
            newData.hasError = false;
            newData.hasUpcChange = false;
            newData.tags = [];
            newData.lastUpdated = new Date().toISOString().split('T')[0];
            if (!newData.regions) newData.regions = ['National'];
            const statusDisplayToInternal = {
                'Pipeline': 'pipeline', 'Pre-launch': 'pre-launch', 'Active': 'active',
                'Hub active': 'hub-active', 'Hub Active': 'hub-active', 'LTO': 'lto',
                'UPC Changes': 'upc-changes', 'Discontinuing': 'discontinuing',
                'DISCO': 'discontinued', 'Unknown': 'unknown',
            };
            const statusClassLookup = {
                'pipeline': 'pipeline', 'pre-launch': 'prelaunch', 'active': 'active',
                'hub-active': 'hubactive', 'lto': 'lto', 'upc-changes': 'upcchanges',
                'discontinuing': 'discontinuing', 'discontinued': 'discontinued', 'unknown': 'unknown',
            };
            newData.status = statusDisplayToInternal[newData.status] || (newData.status || 'unknown').toLowerCase();
            newData.statusClass = statusClassLookup[newData.status] || newData.status;
            DataStore.state.items.push(newData);
        }

        UIManager.updateUI();
    },

    initBulkActions() {
        const addNewBtn = document.querySelector('.btn-primary');
        if (addNewBtn && addNewBtn.textContent.trim() === 'Add New Product') {
            addNewBtn.addEventListener('click', () => {
                EventHandler.openProductDrawer(null, 'create');
            });
        }

        const exportBtn = document.querySelector('.btn-secondary');
        if (exportBtn && exportBtn.textContent.trim() === 'Export') {
            exportBtn.addEventListener('click', () => {
                const allFiltered = DataAccessor.getFilteredData();
                if (allFiltered.length === 0) return alert('No data to export');

                const headers = ['SKU', 'BU', 'Status', 'Title', 'Region', 'Category'];
                const rows = allFiltered.map(item => [
                    item.sku, item.bu, item.status, '"' + item.title.replace(/"/g, '""') + '"',
                    '"' + (item.regions || item.region || []).join(', ') + '"', item.category
                ]);
                const csvContent = [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
                
                const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.setAttribute('href', url);
                link.setAttribute('download', 'catalog_export.csv');
                link.style.visibility = 'hidden';
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            });
        }
    }
};

// ============================================================================
// IMPORT DATA (Mismo JSON array original)
// ============================================================================
const tableData = [
  {
    "id": 1,
    "status": "discontinued",
    "bu": "FLNA",
    "customer": "Amazon.com",
    "vendor": "FRIT1",
    "sku": "B09DDB11HX",
    "upc": "028400686907",
    "gtin": "028400686907",
    "title": "Doritos Spicy Sweet Chili Party Size, 14.5oz",
    "brand": "DORITOS",
    "subBrand": "Spicy Sweet Chili",
    "vol": "Party Size",
    "packType": "PARTY SIZE",
    "packCount": "6",
    "unitCost": "5.36",
    "srp": "7.29",
    "cogs": "32.16",
    "rsvPy": "175368",
    "rsvYtd": "57750",
    "rsvFinancePackSize2024": "PARTY SIZE",
    "resetDate": "01/15/25",
    "inMarketDate": "01/11/25",
    "tags": [
      "Innovation 2025",
      "Fusion"
    ],
    "regions": [
      "Pacific Northwest"
    ],
    "lastUpdated": "07/24/26 4:29AM",
    "conflict": true,
    "category": "salty snacks",
    "subCategory": "tortilla chips",
    "form": "chip",
    "discoDate": "09/01/26"
  },
  {
    "id": 2,
    "status": "lto",
    "bu": "FLNA",
    "customer": "Amazon Fresh",
    "vendor": "FRIT1",
    "sku": "B0FHWRFXDN",
    "upc": "028400784009",
    "gtin": "028400784009",
    "title": "XL Lay's Hot Sauce LTO",
    "brand": "LAY'S",
    "subBrand": "Classic",
    "vol": "XL",
    "packType": "Take Home (Regular)",
    "packCount": "24",
    "unitCost": "3.16",
    "srp": "4.29",
    "cogs": "47.40",
    "rsvPy": "0",
    "rsvYtd": "0",
    "rsvFinancePackSize2024": "Take Home (Regular)",
    "resetDate": "03/01/25",
    "inMarketDate": "02/16/25",
    "tags": [],
    "regions": [
      "National"
    ],
    "lastUpdated": "06/16/26 12:53AM",
    "conflict": false,
    "category": "salty snacks",
    "subCategory": "potato chips",
    "form": "chip"
  },
  {
    "id": 3,
    "status": "lto",
    "bu": "FLNA",
    "customer": "Walmart",
    "vendor": "FRIT1",
    "sku": "B0D1YQXNB9",
    "upc": "028400745857",
    "gtin": "B0D1YQXNB9",
    "title": "Cheetos Crunchy Flamin' Hot Cajun Cheddar 8.5oz",
    "brand": "CHEETOS",
    "subBrand": "White Cheddar",
    "vol": "XL",
    "packType": "TAKE HOME (REGULAR)",
    "packCount": "10",
    "unitCost": "4.35",
    "srp": "5.89",
    "cogs": null,
    "rsvPy": null,
    "rsvYtd": null,
    "rsvFinancePackSize2024": "TAKE HOME (REGULAR)",
    "resetDate": "04/15/25",
    "inMarketDate": "03/23/25",
    "tags": [
      "Innovation 2026"
    ],
    "regions": [
      "National"
    ],
    "lastUpdated": "07/18/26 2:42PM",
    "conflict": false,
    "category": "salty snacks",
    "subCategory": "cheese snacks",
    "form": "chip"
  },
  {
    "id": 4,
    "status": "upc-changes",
    "bu": "FLNA",
    "customer": "Catalog",
    "vendor": "FRIT1",
    "sku": "B00CNZTS0S",
    "upc": "028400019378",
    "gtin": "028400019378",
    "title": "Ruffles Queso Flavored Potato Chips, 6.5 Ounce",
    "brand": "RUFFLES",
    "subBrand": "Queso Flavored",
    "vol": "Hispanic XL",
    "packType": "TAKE HOME (REGULAR)",
    "packCount": "8",
    "unitCost": "2.94",
    "srp": "3.99",
    "cogs": "23.52",
    "rsvPy": "0",
    "rsvYtd": "0",
    "rsvFinancePackSize2024": "TAKE HOME (REGULAR)",
    "resetDate": "06/01/25",
    "inMarketDate": "05/05/25",
    "tags": [
      "Low ASP"
    ],
    "regions": [
      "Pacific Northwest",
      "Southwest",
      "Northeast"
    ],
    "lastUpdated": "03/18/26 7:28PM",
    "conflict": false,
    "category": "salty snacks",
    "subCategory": "potato chips",
    "form": "chip",
    "statusClass": "upcchanges",
    "upcOld": "028400019378",
    "upcNew": "028400019999",
    "upcChangeDate": "03/15/26",
    "upcChangeReason": "Package redesign"
  },
  {
    "id": 5,
    "status": "lto",
    "bu": "FLNA",
    "customer": "Amazon.com",
    "vendor": "FRIT1",
    "sku": "B0D7MKN6V2",
    "upc": "028400757591",
    "gtin": "B0D7MKN6V2",
    "title": "Tostitos Holiday Red Scoops 10oz",
    "brand": "TOSTITOS",
    "subBrand": "Holiday Red",
    "vol": "TAKE HOME (REGULAR)",
    "packType": "",
    "packCount": "6",
    "unitCost": "4.41",
    "srp": "5.99",
    "cogs": null,
    "rsvPy": null,
    "rsvYtd": null,
    "rsvFinancePackSize2024": "",
    "resetDate": "07/15/25",
    "inMarketDate": "06/15/25",
    "tags": [
      "Innovation 2025"
    ],
    "regions": [
      "Northeast"
    ],
    "lastUpdated": "07/24/26 4:34PM",
    "conflict": false,
    "category": "salty snacks",
    "subCategory": "tortilla chips",
    "form": "chip"
  },
  {
    "id": 6,
    "status": "active",
    "bu": "FLNA",
    "customer": "Amazon Fresh",
    "vendor": "FRIT1",
    "sku": "B0DTBS9LNL",
    "upc": "028400769181",
    "gtin": "028400769181",
    "title": "Fritos Original, 3.375oz",
    "brand": "FRITOS",
    "subBrand": "Original, 3.375oz",
    "vol": "XXVL",
    "packType": "SINGLE SERVE",
    "packCount": "5",
    "unitCost": "1.88",
    "srp": "2.69",
    "cogs": "67.68",
    "rsvPy": "0",
    "rsvYtd": "50",
    "rsvFinancePackSize2024": "SINGLE SERVE",
    "resetDate": "09/01/25",
    "inMarketDate": "08/19/25",
    "tags": [],
    "regions": [
      "National"
    ],
    "lastUpdated": "06/19/26 4:52AM",
    "conflict": false,
    "category": "salty snacks",
    "subCategory": "corn chips",
    "form": "chip"
  },
  {
    "id": 7,
    "status": "active",
    "bu": "PBNA",
    "customer": "Walmart",
    "vendor": "PEQF9",
    "sku": "B0FVFVCBWW",
    "upc": "012000250552",
    "gtin": "B0FVFVCBWW",
    "title": "Pepsi Prebiotic Cola - Original Cola 12oz SS",
    "brand": "PEPSI",
    "subBrand": "Zero Sugar",
    "vol": "CSD12oz 12L",
    "packType": "CSD12oz 12L",
    "packCount": "36",
    "unitCost": "1.17",
    "srp": "1.68",
    "cogs": null,
    "rsvPy": null,
    "rsvYtd": "276",
    "rsvFinancePackSize2024": "CSD12oz 12L",
    "resetDate": "10/15/25",
    "inMarketDate": "09/09/25",
    "tags": [
      "Low ASP",
      "Innovation 2026"
    ],
    "regions": [
      "National"
    ],
    "lastUpdated": "07/21/26 11:35PM",
    "conflict": false,
    "category": "csd",
    "subCategory": "carbonated soft drinks",
    "form": "can"
  },
  {
    "id": 8,
    "status": "hub-active",
    "bu": "PBNA",
    "customer": "Catalog",
    "vendor": "PEQF9",
    "sku": "B018IB3ZIG",
    "upc": "052000103106",
    "gtin": "052000103106",
    "title": "Gatorade Drink, All Star Glacier Cherry, 12 oz 6 pack",
    "brand": "GATORADE",
    "subBrand": "Zero",
    "vol": "",
    "packType": "Gatorade 12oz 6pk",
    "packCount": "12",
    "unitCost": "4.28",
    "srp": "5.10",
    "cogs": "34.24",
    "rsvPy": "38930",
    "rsvYtd": "420",
    "rsvFinancePackSize2024": "Gatorade 12oz 6pk",
    "resetDate": "01/15/26",
    "inMarketDate": "10/06/25",
    "tags": [
      "Fusion"
    ],
    "regions": [
      "Southeast",
      "Southwest",
      "West"
    ],
    "lastUpdated": "09/24/26 4:26AM",
    "conflict": true,
    "category": "sports drinks",
    "subCategory": "isotonic",
    "form": "bottle"
  },
  {
    "id": 9,
    "status": "lto",
    "bu": "PBNA",
    "customer": "Amazon.com",
    "vendor": "PEQF9",
    "sku": "B0GKH9QS6V",
    "upc": "012000240294",
    "gtin": "B0GKH9QS6V",
    "title": "Starry Cranberry Blizz Zero Sugar LTO - 2Lt",
    "brand": "STARRY",
    "subBrand": "Cranberry Blizz",
    "vol": "CSD2 Liter 8L",
    "packType": "CSD2 Liter 8L",
    "packCount": "4",
    "unitCost": "2.32",
    "srp": "2.92",
    "cogs": null,
    "rsvPy": null,
    "rsvYtd": null,
    "rsvFinancePackSize2024": "CSD2 Liter 8L",
    "resetDate": "03/01/26",
    "inMarketDate": "11/02/25",
    "tags": [
      "Innovation 2026",
      "Low ASP"
    ],
    "regions": [
      "National"
    ],
    "lastUpdated": "01/13/26 5:14AM",
    "conflict": false,
    "category": "csd",
    "subCategory": "carbonated soft drinks",
    "form": "bottle"
  },
  {
    "id": 10,
    "status": "active",
    "bu": "PBNA",
    "customer": "Amazon Fresh",
    "vendor": "PEQF9",
    "sku": "B08N6B3CXR",
    "upc": "818094004718",
    "gtin": "818094005777",
    "title": "Rockstar Energy Drink, Original, 16 Fl Oz Can",
    "brand": "ROCKSTAR",
    "subBrand": "Energy Drink,",
    "vol": "Rockstar TotalCan 16oz 12L",
    "packType": "Rockstar TotalCan 16oz 12L",
    "packCount": "24",
    "unitCost": "2.19",
    "srp": "2.64",
    "cogs": "26.28",
    "rsvPy": "29073",
    "rsvYtd": "7303",
    "rsvFinancePackSize2024": "Rockstar TotalCan 16oz 12L",
    "resetDate": "04/15/26",
    "inMarketDate": "01/11/26",
    "tags": [
      "Innovation 2026",
      "Low ASP"
    ],
    "regions": [
      "Southeast"
    ],
    "lastUpdated": "05/16/26 2:35PM",
    "conflict": false,
    "category": "energy",
    "subCategory": "energy drinks",
    "form": "can"
  },
  {
    "id": 11,
    "status": "active",
    "bu": "PBNA",
    "customer": "Walmart",
    "vendor": "PEQF9",
    "sku": "B089179WJ5",
    "upc": "889392010381",
    "gtin": "889392010381",
    "title": "CELSIUS Sparkling Peach Vibe, Functional Essential Energy Drink 12 Fl Oz (Pack of 4)",
    "brand": "CELSIUS",
    "subBrand": "Sparkling Peach",
    "vol": "CelsiusCan 12oz 4P",
    "packType": "CelsiusCan 12oz 4P",
    "packCount": "10",
    "unitCost": "5.99",
    "srp": "8.99",
    "cogs": "35.94",
    "rsvPy": "160177",
    "rsvYtd": "45696",
    "rsvFinancePackSize2024": "CelsiusCan 12oz 4P",
    "resetDate": "06/01/26",
    "inMarketDate": "02/09/26",
    "tags": [],
    "regions": [
      "Midwest",
      "Southeast"
    ],
    "lastUpdated": "03/14/26 8:54AM",
    "conflict": false,
    "category": "energy",
    "subCategory": "energy drinks",
    "form": "can"
  },
  {
    "id": 12,
    "status": "discontinued",
    "bu": "PBNA",
    "customer": "Catalog",
    "vendor": "PEQF9",
    "sku": "B000R9GN50",
    "upc": "012000101144",
    "gtin": "012000101144",
    "title": "Starbucks Frappuccino Vanilla Coffee Beverage, 9.5 oz glass bottles (4 Pack)",
    "brand": "STARBUCKS",
    "subBrand": "Doubleshot",
    "vol": "Frappuccino Total9.5oz 4P",
    "packType": "Frappuccino Total9.5oz 4P",
    "packCount": "8",
    "unitCost": "7.27",
    "srp": "10.41",
    "cogs": "43.62",
    "rsvPy": "591103",
    "rsvYtd": "106293",
    "rsvFinancePackSize2024": "Frappuccino Total9.5oz 4P",
    "resetDate": "09/01/26",
    "inMarketDate": "03/23/26",
    "tags": [
      "Overlap ASIN"
    ],
    "regions": [
      "National"
    ],
    "lastUpdated": "05/24/26 10:54PM",
    "conflict": false,
    "category": "coffee",
    "subCategory": "ready to drink coffee",
    "form": "bottle",
    "discoDate": "09/01/26"
  },
  {
    "id": 13,
    "status": "active",
    "bu": "PBNA",
    "customer": "Amazon.com",
    "vendor": "PEQF9",
    "sku": "B07L6BSPM7",
    "upc": "012000181672",
    "gtin": "012000181672",
    "title": "Pure Leaf Sweetened Iced Tea With Lemon, 16.9 Fl. Oz (pack of 6)",
    "brand": "PURE LEAF",
    "subBrand": "Leaf Sweetened",
    "vol": "Lipton Pure Leaf Total16.9oz 6P",
    "packType": "Lipton Pure Leaf Total16.9oz 6P",
    "packCount": "6",
    "unitCost": "7.41",
    "srp": "9.83",
    "cogs": "14.82",
    "rsvPy": "158143",
    "rsvYtd": "49542",
    "rsvFinancePackSize2024": "Lipton Pure Leaf Total16.9oz 6P",
    "resetDate": "01/15/25",
    "inMarketDate": "05/18/26",
    "tags": [
      "Innovation 2026",
      "Innovation 2025"
    ],
    "regions": [
      "Northeast"
    ],
    "lastUpdated": "09/17/26 8:43PM",
    "conflict": false,
    "category": "tea",
    "subCategory": "ready to drink tea",
    "form": "bottle"
  },
  {
    "id": 14,
    "status": "pipeline",
    "bu": "PBNA",
    "customer": "Amazon Fresh",
    "vendor": "PGTR1",
    "sku": "B0GX6YW76B",
    "upc": "052000066470",
    "gtin": "B0GX6YW76B",
    "title": "Propel Boost Raspberry Green Tea Water Beverage Mix with Electrolytes and Vitamins (8 Packets)",
    "brand": "PROPEL",
    "subBrand": "Boost Raspberry",
    "vol": "MP-Straight 8ct",
    "packType": "Propel Powder Stick",
    "packCount": "6",
    "unitCost": "3.72",
    "srp": "5.19",
    "cogs": null,
    "rsvPy": null,
    "rsvYtd": null,
    "rsvFinancePackSize2024": "Propel Powder Stick",
    "resetDate": "03/01/25",
    "inMarketDate": "06/22/26",
    "tags": [
      "Innovation 2026"
    ],
    "regions": [
      "National"
    ],
    "lastUpdated": "01/28/26 11:44PM",
    "conflict": false,
    "category": "sports drinks",
    "subCategory": "isotonic",
    "form": "bottle"
  },
  {
    "id": 15,
    "status": "pipeline",
    "bu": "PBNA",
    "customer": "Walmart",
    "vendor": "PGTR1",
    "sku": "B08X6B6BF4",
    "upc": "012000206863",
    "gtin": "012000206863",
    "title": "Bubly Summer Coconut Pineapple",
    "brand": "BUBLY",
    "subBrand": "Summer Coconut",
    "vol": "Bubly TotalCan 12oz 8P FM",
    "packType": "Bubly TotalCan 12oz 8P FM",
    "packCount": "6",
    "unitCost": "3.38",
    "srp": "5.21",
    "cogs": "3.38",
    "rsvPy": "264247",
    "rsvYtd": "57315",
    "rsvFinancePackSize2024": "Bubly TotalCan 12oz 8P FM",
    "resetDate": "04/15/25",
    "inMarketDate": "08/03/26",
    "tags": [
      "Innovation 2026"
    ],
    "regions": [
      "National"
    ],
    "lastUpdated": "03/28/26 1:35PM",
    "conflict": true,
    "category": "water",
    "subCategory": "sparkling water",
    "form": "can"
  },
  {
    "id": 16,
    "status": "upc-changes",
    "bu": "PBNA",
    "customer": "Catalog",
    "vendor": "PEQF9",
    "sku": "PEPASIN287",
    "upc": "810063711511",
    "gtin": "PEPASIN287",
    "title": "Poppi Orange 7.5oz 6 Pack Can",
    "brand": "POPPI",
    "subBrand": "Orange 7.5oz",
    "vol": "Poppi 7.5oz 6PK",
    "packType": "Poppi 7.5oz 6PK",
    "packCount": "36",
    "unitCost": "7.56",
    "srp": "10.99",
    "cogs": null,
    "rsvPy": null,
    "rsvYtd": null,
    "rsvFinancePackSize2024": "Poppi 7.5oz 6PK",
    "resetDate": "06/01/25",
    "inMarketDate": "01/11/25",
    "tags": [
      "Overlap ASIN"
    ],
    "regions": [
      "National"
    ],
    "lastUpdated": "03/24/26 1:54AM",
    "conflict": false,
    "category": "csd",
    "subCategory": "prebiotic soda",
    "form": "can",
    "statusClass": "upcchanges",
    "upcOld": "810063711511",
    "upcNew": "810063719999",
    "upcChangeDate": "03/15/26",
    "upcChangeReason": "Package redesign"
  },
  {
    "id": 17,
    "status": "lto",
    "bu": "QUAKER",
    "customer": "Amazon.com",
    "vendor": "PEPQU",
    "sku": "B0DJ9QL66T",
    "upc": "030000569504",
    "gtin": "10030000569501",
    "title": "Chewy Spring Mini's 12 ct",
    "brand": "QUAKER CHEWY",
    "subBrand": "Spring Mini's",
    "vol": "CHEWY .49OZ 12/28CT MINI CCP SPRING",
    "packType": "CHEWY,SMALL,12-1-28 BP",
    "packCount": "8",
    "unitCost": "4.98",
    "srp": "1.79",
    "cogs": "59.82",
    "rsvPy": "0",
    "rsvYtd": "0",
    "rsvFinancePackSize2024": "CHEWY,SMALL,12-1-28 BP",
    "resetDate": "07/15/25",
    "inMarketDate": "02/16/25",
    "tags": [],
    "regions": [
      "National"
    ],
    "lastUpdated": "08/15/26 5:27AM",
    "conflict": false,
    "category": "snack bars",
    "subCategory": "granola bars",
    "form": "bar"
  },
  {
    "id": 18,
    "status": "hub-active",
    "bu": "QUAKER",
    "customer": "Amazon Fresh",
    "vendor": "PEPQU",
    "sku": "B000RPUCQK",
    "upc": "030000010204",
    "gtin": "00030000013212",
    "title": "Quaker Oats Old Fashioned 18 Oz",
    "brand": "SQO",
    "subBrand": "Oats Old",
    "vol": "SQO OLD FASH 18OZ 12CS REGULAR",
    "packType": "STANDARD QUAKER OATS,SMALL,12-1-1",
    "packCount": "6",
    "unitCost": "3.46",
    "srp": "4.49",
    "cogs": "41.54",
    "rsvPy": "129692",
    "rsvYtd": "22955",
    "rsvFinancePackSize2024": "STANDARD QUAKER OATS,SMALL,12-1-1",
    "resetDate": "09/01/25",
    "inMarketDate": "03/23/25",
    "tags": [],
    "regions": [
      "National"
    ],
    "lastUpdated": "03/21/26 11:44PM",
    "conflict": false,
    "category": "hot cereals",
    "subCategory": "oatmeal",
    "form": "bag"
  },
  {
    "id": 19,
    "status": "hub-active",
    "bu": "QUAKER",
    "customer": "Walmart",
    "vendor": "PEPQU",
    "sku": "B08XD5FW3D",
    "upc": "030000572429",
    "gtin": "10030000572426",
    "title": "Quaker Natural Granola Cereal, 28 Oz",
    "brand": "SIMPLY GRANOLA",
    "subBrand": "Natural Granola",
    "vol": "QSG 24.1OZ 10CS REGULAR",
    "packType": "QUAKER NATURAL CEREAL,XLARGE,10-1-1",
    "packCount": "6",
    "unitCost": "4.03",
    "srp": "1.79",
    "cogs": "40.31",
    "rsvPy": "92",
    "rsvYtd": "5873",
    "rsvFinancePackSize2024": "QUAKER NATURAL CEREAL,XLARGE,10-1-1",
    "resetDate": "10/15/25",
    "inMarketDate": "05/05/25",
    "tags": [
      "Overlap ASIN"
    ],
    "regions": [
      "National"
    ],
    "lastUpdated": "09/12/26 1:58AM",
    "conflict": false,
    "category": "cold cereals",
    "subCategory": "granola",
    "form": "bag"
  },
  {
    "id": 20,
    "status": "pipeline",
    "bu": "QUAKER",
    "customer": "Catalog",
    "vendor": "PEPQU",
    "sku": "B0G4SG1SK4",
    "upc": "030000580417",
    "gtin": "B0G4SG1SK4",
    "title": "RICE CRISPS SPICY/SVRY 15CT/4CS VP",
    "brand": "RICE CRISPS",
    "subBrand": "CRISPS SPICY/SVRY",
    "vol": "MP-Variety 15ct",
    "packType": "MP-Variety 15ct",
    "packCount": "8",
    "unitCost": "10.50",
    "srp": "13.69",
    "cogs": null,
    "rsvPy": null,
    "rsvYtd": null,
    "rsvFinancePackSize2024": "MP-Variety 15ct",
    "resetDate": "01/15/26",
    "inMarketDate": "06/15/25",
    "tags": [
      "Low ASP"
    ],
    "regions": [
      "National"
    ],
    "lastUpdated": "03/20/26 1:31AM",
    "conflict": false,
    "category": "salty snacks",
    "subCategory": "rice snacks",
    "form": "crisp"
  },
  {
    "id": 21,
    "status": "lto",
    "bu": "FLNA",
    "customer": "Amazon.com",
    "vendor": "FRIT1",
    "sku": "B0CWLXWYHS",
    "upc": "028400735568",
    "gtin": "B0CWLXWYHS",
    "title": "Smartfood Chocolate Glazed Donut 6.5oz",
    "brand": "SMARTFOOD",
    "subBrand": "Chocolate Glazed",
    "vol": "TAKE HOME (REGULAR)",
    "packType": "",
    "packCount": "6",
    "unitCost": "3.82",
    "srp": "5.19",
    "cogs": null,
    "rsvPy": null,
    "rsvYtd": null,
    "rsvFinancePackSize2024": "",
    "resetDate": "03/01/26",
    "inMarketDate": "08/19/25",
    "tags": [
      "Low ASP"
    ],
    "regions": [
      "Southwest"
    ],
    "lastUpdated": "02/14/26 8:51AM",
    "conflict": false,
    "category": "salty snacks",
    "subCategory": "popcorn",
    "form": "popcorn"
  },
  {
    "id": 22,
    "status": "hub-active",
    "bu": "FLNA",
    "customer": "Amazon Fresh",
    "vendor": "FRIT1",
    "sku": "B0CWLT2KJF",
    "upc": "028400737012",
    "gtin": "028400737012",
    "title": "SunChips Harvest Cheddar Party Size - 12 OZ",
    "brand": "SUNCHIPS",
    "subBrand": "Harvest Cheddar",
    "vol": "Party Size",
    "packType": "PARTY SIZE",
    "packCount": "5",
    "unitCost": "5.36",
    "srp": "7.29",
    "cogs": "32.16",
    "rsvPy": "0",
    "rsvYtd": "0",
    "rsvFinancePackSize2024": "PARTY SIZE",
    "resetDate": "04/15/26",
    "inMarketDate": "09/09/25",
    "tags": [
      "Overlap ASIN",
      "Innovation 2026"
    ],
    "regions": [
      "National"
    ],
    "lastUpdated": "08/12/26 3:20AM",
    "conflict": true,
    "category": "salty snacks",
    "subCategory": "multigrain chips",
    "form": "chip"
  },
  {
    "id": 23,
    "status": "discontinued",
    "bu": "FLNA",
    "customer": "Walmart",
    "vendor": "PEPQU",
    "sku": "B00CEYJNJY",
    "upc": "028400008488",
    "gtin": "028400008488",
    "title": "Stacy's Pita Chips Simply Naked Pita Crisps, 6.75 oz",
    "brand": "STACY'S",
    "subBrand": "Pita Chips",
    "vol": "1 CT 6.75 OZ",
    "packType": "1 CT 6.75 OZ",
    "packCount": "12",
    "unitCost": "3.11",
    "srp": "4.19",
    "cogs": "24.88",
    "rsvPy": "214747",
    "rsvYtd": "65982",
    "rsvFinancePackSize2024": "1 CT 6.75 OZ",
    "resetDate": "06/01/26",
    "inMarketDate": "10/06/25",
    "tags": [
      "Low ASP"
    ],
    "regions": [
      "Southwest",
      "Southeast"
    ],
    "lastUpdated": "07/10/26 5:20PM",
    "conflict": false,
    "category": "salty snacks",
    "subCategory": "pita chips",
    "form": "chip",
    "discoDate": "11/15/26"
  },
  {
    "id": 24,
    "status": "pipeline",
    "bu": "FLNA",
    "customer": "Catalog",
    "vendor": "FRIT1",
    "sku": "B0FT8RHSZ7",
    "upc": "028400789622",
    "gtin": "B0FT8RHSZ7",
    "title": "XL Miss Vickie\u2019s Made\u00a0With Avocado Oil Sea Salt & Vinegar",
    "brand": "MISS VICKIE'S",
    "subBrand": "Miss Vickie\u2019s",
    "vol": "XL",
    "packType": "Take Home (Regular)",
    "packCount": "6",
    "unitCost": "3.49",
    "srp": "4.99",
    "cogs": null,
    "rsvPy": null,
    "rsvYtd": null,
    "rsvFinancePackSize2024": "Take Home (Regular)",
    "resetDate": "09/01/26",
    "inMarketDate": "11/02/25",
    "tags": [],
    "regions": [
      "Pacific Northwest"
    ],
    "lastUpdated": "05/19/26 2:41PM",
    "conflict": false,
    "category": "salty snacks",
    "subCategory": "potato chips",
    "form": "chip"
  },
  {
    "id": 25,
    "status": "hub-active",
    "bu": "QUAKER",
    "customer": "Amazon.com",
    "vendor": "PEPQU",
    "sku": "B0014E4KA2",
    "upc": "015300430471",
    "gtin": "00015300014893",
    "title": "Rice-A-Roni Rice Mix Long Grain and Wild 4.3 oz",
    "brand": "RICE A RONI",
    "subBrand": "Rice Mix",
    "vol": "RAR 4.3OZ 12CS LG WILD HERB",
    "packType": "RICE A RONI,LARGE,12-1-1",
    "packCount": "8",
    "unitCost": "1.66",
    "srp": "2.66",
    "cogs": "19.94",
    "rsvPy": "22185",
    "rsvYtd": "9302",
    "rsvFinancePackSize2024": "RICE A RONI,LARGE,12-1-1",
    "resetDate": "01/15/25",
    "inMarketDate": "01/11/26",
    "tags": [],
    "regions": [
      "National"
    ],
    "lastUpdated": "06/20/26 11:30AM",
    "conflict": false,
    "category": "side dishes",
    "subCategory": "rice & pasta",
    "form": "box"
  },
  {
    "id": 26,
    "status": "lto",
    "bu": "PBNA",
    "customer": "Amazon Fresh",
    "vendor": "PEQF9",
    "sku": "PEPASIN255",
    "upc": "078000394160",
    "gtin": "PEPASIN255",
    "title": "Schweppes Cranberry Raspberry LTO - 2Lt",
    "brand": "SCHWEPPES",
    "subBrand": "Cranberry Raspberry",
    "vol": "CSD2 Liter 8L",
    "packType": "CSD2 Liter 8L",
    "packCount": "12",
    "unitCost": null,
    "srp": "2.92",
    "cogs": "2.32",
    "rsvPy": null,
    "rsvYtd": null,
    "rsvFinancePackSize2024": "CSD2 Liter 8L",
    "resetDate": "03/01/25",
    "inMarketDate": "02/09/26",
    "tags": [
      "Innovation 2026",
      "Low ASP"
    ],
    "regions": [
      "National"
    ],
    "lastUpdated": "09/14/26 12:53PM",
    "conflict": false,
    "category": "csd",
    "subCategory": "carbonated soft drinks",
    "form": "bottle"
  },
  {
    "id": 27,
    "status": "unknown",
    "bu": "PBNA",
    "customer": "Walmart",
    "vendor": "PEQF9",
    "sku": "B0F2HCDZFN",
    "upc": "098000100905",
    "gtin": "098000100905",
    "title": "Lipton Fusions 16oz SS - Passionfruit Lemonade",
    "brand": "LIPTON",
    "subBrand": "Fusions 16oz",
    "vol": "Lipton 16oz",
    "packType": "Lipton 16oz",
    "packCount": "10",
    "unitCost": "1.49",
    "srp": "2.02",
    "cogs": "17.88",
    "rsvPy": "0",
    "rsvYtd": "0",
    "rsvFinancePackSize2024": "Lipton 16oz",
    "resetDate": "04/15/25",
    "inMarketDate": "03/23/26",
    "tags": [
      "Low ASP",
      "Innovation 2026"
    ],
    "regions": [
      "National"
    ],
    "lastUpdated": "04/15/26 9:36AM",
    "conflict": false,
    "category": "tea",
    "subCategory": "ready to drink tea",
    "form": "bottle"
  },
  {
    "id": 28,
    "status": "pipeline",
    "bu": "QUAKER",
    "customer": "Catalog",
    "vendor": "PEPQU",
    "sku": "B0GWH31XM2",
    "upc": "030000581605",
    "gtin": "B0GWH31XM2",
    "title": "QKR OAT SHAKE AND GO CINNAMON VANILLA  BTL 1.5OZ",
    "brand": "Quaker",
    "subBrand": "OAT SHAKE",
    "vol": "OATMEAL TO GO-SHAKE,LARGE,10-1-1",
    "packType": "OATMEAL TO GO-SHAKE,LARGE,10-1-1",
    "packCount": "8",
    "unitCost": "2.86",
    "srp": "2.79",
    "cogs": null,
    "rsvPy": null,
    "rsvYtd": null,
    "rsvFinancePackSize2024": "OATMEAL TO GO-SHAKE,LARGE,10-1-1",
    "resetDate": "06/01/25",
    "inMarketDate": "05/18/26",
    "tags": [],
    "regions": [
      "National"
    ],
    "lastUpdated": "02/23/26 1:46AM",
    "conflict": false,
    "category": "hot cereals",
    "subCategory": "oatmeal",
    "form": "bag"
  },
  {
    "id": 29,
    "status": "upc-changes",
    "bu": "QUAKER",
    "customer": "Amazon.com",
    "vendor": "PEPQU",
    "sku": "B0CR1XPKL4",
    "upc": "030000578322",
    "gtin": "10030000578329",
    "title": "Quaker Protein Bars: Peanut Butter & Chocolate 12 ct",
    "brand": "QUAKER PROTEIN",
    "subBrand": "Protein Bars:",
    "vol": "QUAKER PROTEIN CHEWY 40G 5CT 12CS PNTBRC",
    "packType": "PROTEIN BAR,LARGE,12-1-5",
    "packCount": "12",
    "unitCost": "4.15",
    "srp": "6.89",
    "cogs": "49.85",
    "rsvPy": "0",
    "rsvYtd": "0",
    "rsvFinancePackSize2024": "PROTEIN BAR,LARGE,12-1-5",
    "resetDate": "07/15/25",
    "inMarketDate": "06/22/26",
    "tags": [
      "Overlap ASIN",
      "Innovation 2025"
    ],
    "regions": [
      "National"
    ],
    "lastUpdated": "05/15/26 10:58PM",
    "conflict": true,
    "category": "snack bars",
    "subCategory": "granola bars",
    "form": "bar",
    "statusClass": "upcchanges",
    "upcOld": "030000578322",
    "upcNew": "030000579999",
    "upcChangeDate": "03/15/26",
    "upcChangeReason": "Package redesign"
  },
  {
    "id": 30,
    "status": "active",
    "bu": "PBNA",
    "customer": "Amazon Fresh",
    "vendor": "PEQF9",
    "sku": "B0012V2NUG",
    "upc": "012000810091",
    "gtin": "012000810091",
    "title": "Lipton Brisk Lemon Iced Tea, 12 Fl Oz (pack of 12)",
    "brand": "BRISK",
    "subBrand": "Brisk Lemon",
    "vol": "Lipton Iced Tea TOtal12oz 12P FM",
    "packType": "Lipton Iced Tea TOtal12oz 12P FM",
    "packCount": "5",
    "unitCost": "7.18",
    "srp": "8.82",
    "cogs": "14.36",
    "rsvPy": "611009",
    "rsvYtd": "148145",
    "rsvFinancePackSize2024": "Lipton Iced Tea TOtal12oz 12P FM",
    "resetDate": "09/01/25",
    "inMarketDate": "08/03/26",
    "tags": [],
    "regions": [
      "National"
    ],
    "lastUpdated": "07/24/26 2:20AM",
    "conflict": false,
    "category": "tea",
    "subCategory": "ready to drink tea",
    "form": "bottle"
  },
  {
    "id": 31,
    "status": "lto",
    "bu": "PBNA",
    "customer": "Walmart",
    "vendor": "PEQF9",
    "sku": "PEPASIN246",
    "upc": "Not Available",
    "gtin": "PEPASIN246",
    "title": "Portfolio CSD - Football Variety Pack",
    "brand": "Portfolio CSD",
    "subBrand": "CSD -",
    "vol": "",
    "packType": "",
    "packCount": "8",
    "unitCost": null,
    "srp": null,
    "cogs": null,
    "rsvPy": null,
    "rsvYtd": null,
    "rsvFinancePackSize2024": "",
    "resetDate": "10/15/25",
    "inMarketDate": "01/11/25",
    "tags": [
      "Overlap ASIN"
    ],
    "regions": [
      "Southeast",
      "Midwest"
    ],
    "lastUpdated": "02/21/26 9:20PM",
    "conflict": false,
    "category": "beverages",
    "subCategory": "other beverages",
    "form": "can"
  },
  {
    "id": 32,
    "status": "hub-active",
    "bu": "QUAKER",
    "customer": "Catalog",
    "vendor": "PEPQU",
    "sku": "B00HK0OBI0",
    "upc": "030000064030",
    "gtin": "00030000571200",
    "title": "QUAKER Oatmeal Squares Cereal, Brown Sugar, 21oz",
    "brand": "QK OAT SQUARES",
    "subBrand": "Oatmeal Squares",
    "vol": "",
    "packType": "QUAKER TOASTED OATMEAL SQUARES,XLARGE,1",
    "packCount": "5",
    "unitCost": "5.95",
    "srp": "0.00",
    "cogs": "59.50",
    "rsvPy": "95",
    "rsvYtd": "886",
    "rsvFinancePackSize2024": "QUAKER TOASTED OATMEAL SQUARES,XLARGE,1",
    "resetDate": "01/15/26",
    "inMarketDate": "02/16/25",
    "tags": [
      "Overlap ASIN"
    ],
    "regions": [
      "National"
    ],
    "lastUpdated": "04/15/26 3:40AM",
    "conflict": false,
    "category": "hot cereals",
    "subCategory": "oatmeal",
    "form": "bag"
  },
  {
    "id": 33,
    "status": "pipeline",
    "bu": "PBNA",
    "customer": "Amazon.com",
    "vendor": "GJPEP",
    "sku": "B00OGKLRR0",
    "upc": "012000024504",
    "gtin": "B00OGKLRR0",
    "title": "Pepsi Zero Sugar 12 Fl OZ Pack of 24 Slab",
    "brand": "PEPSI ZERO",
    "subBrand": "Zero Sugar",
    "vol": "CSDCan 12oz 24P Slab",
    "packType": "CSDCan 12oz 24P Slab",
    "packCount": "8",
    "unitCost": "12.90",
    "srp": "13.99",
    "cogs": "12.90",
    "rsvPy": null,
    "rsvYtd": null,
    "rsvFinancePackSize2024": "CSDCan 12oz 24P Slab",
    "resetDate": "03/01/26",
    "inMarketDate": "03/23/25",
    "tags": [],
    "regions": [
      "Pacific Northwest",
      "Northeast",
      "Southeast"
    ],
    "lastUpdated": "09/26/26 9:14PM",
    "conflict": false,
    "category": "beverages",
    "subCategory": "other beverages",
    "form": "can"
  },
  {
    "id": 34,
    "status": "discontinued",
    "bu": "QUAKER",
    "customer": "Amazon Fresh",
    "vendor": "PEPQU",
    "sku": "B08XD4PMPS",
    "upc": "030000568606",
    "gtin": "10030000568603",
    "title": "Quaker Instant Oatmeal, Lower Sugar Variety 10 pkts , 11.5oz",
    "brand": "IQO",
    "subBrand": "Instant Oatmeal,",
    "vol": "IQO 9.3OZ/12CS LS VARIETY PACK - PO",
    "packType": "INSTANT QUAKER OATS,LARGE,12-1-8",
    "packCount": "10",
    "unitCost": "3.71",
    "srp": "5.99",
    "cogs": "44.53",
    "rsvPy": "18",
    "rsvYtd": "19085",
    "rsvFinancePackSize2024": "INSTANT QUAKER OATS,LARGE,12-1-8",
    "resetDate": "04/15/26",
    "inMarketDate": "05/05/25",
    "tags": [
      "Innovation 2026"
    ],
    "regions": [
      "Southeast"
    ],
    "lastUpdated": "09/12/26 4:26PM",
    "conflict": false,
    "category": "hot cereals",
    "subCategory": "instant oatmeal",
    "form": "cup",
    "discoDate": "11/15/26"
  },
  {
    "id": 35,
    "status": "active",
    "bu": "FLNA",
    "customer": "Walmart",
    "vendor": "FRIT1",
    "sku": "B0DYQRD3PL",
    "upc": "028400768535",
    "gtin": "028400768535",
    "title": "Funyuns Hot Onion Flavored Rings 5.25oz",
    "brand": "FUNYUNS",
    "subBrand": "Hot Onion",
    "vol": "1 CT 5.25 OZ",
    "packType": "TAKE HOME (REGULAR)",
    "packCount": "6",
    "unitCost": "3.68",
    "srp": "4.99",
    "cogs": "44.16",
    "rsvPy": "0",
    "rsvYtd": "20167",
    "rsvFinancePackSize2024": "TAKE HOME (REGULAR)",
    "resetDate": "06/01/26",
    "inMarketDate": "06/15/25",
    "tags": [
      "Innovation 2026"
    ],
    "regions": [
      "National"
    ],
    "lastUpdated": "01/11/26 7:13PM",
    "conflict": false,
    "category": "salty snacks",
    "subCategory": "other snacks",
    "form": "chip"
  },
  {
    "id": 36,
    "status": "pipeline",
    "bu": "PBNA",
    "customer": "Catalog",
    "vendor": "PEQF9",
    "sku": "Hold",
    "upc": "012000250927",
    "gtin": "Hold",
    "title": "Mountain Dew Dirty Dew - 20oz Zero Sugar",
    "brand": "MOUNTAIN DEW",
    "subBrand": "Dew Dirty",
    "vol": "CSD20oz 24L",
    "packType": "CSD20oz 24L",
    "packCount": "8",
    "unitCost": "1.78",
    "srp": "5.34",
    "cogs": null,
    "rsvPy": null,
    "rsvYtd": null,
    "rsvFinancePackSize2024": "CSD20oz 24L",
    "resetDate": "09/01/26",
    "inMarketDate": "08/19/25",
    "tags": [
      "Low ASP",
      "Overlap ASIN"
    ],
    "regions": [
      "National"
    ],
    "lastUpdated": "05/10/26 10:43PM",
    "conflict": true,
    "category": "beverages",
    "subCategory": "other beverages",
    "form": "can"
  },
  {
    "id": 37,
    "status": "hub-active",
    "bu": "FLNA",
    "customer": "Amazon.com",
    "vendor": "PEPQU",
    "sku": "B0BG64MHFV",
    "upc": "028400700108",
    "gtin": "0028400700115",
    "title": "Cheetos Mini Canister TH Flamin Hot 3.625 oz",
    "brand": "MINI CANISTERS",
    "subBrand": "Mini Canister",
    "vol": "Canister TH",
    "packType": "Canister TH",
    "packCount": "24",
    "unitCost": "2.09",
    "srp": "3.49",
    "cogs": "25.08",
    "rsvPy": "42387",
    "rsvYtd": "16346",
    "rsvFinancePackSize2024": "Canister TH",
    "resetDate": "01/15/25",
    "inMarketDate": "09/09/25",
    "tags": [
      "Fusion",
      "Overlap ASIN"
    ],
    "regions": [
      "Southwest",
      "Southeast",
      "Midwest"
    ],
    "lastUpdated": "03/19/26 9:26PM",
    "conflict": false,
    "category": "salty snacks",
    "subCategory": "other snacks",
    "form": "chip"
  },
  {
    "id": 38,
    "status": "active",
    "bu": "PBNA",
    "customer": "Amazon Fresh",
    "vendor": "PEQF9",
    "sku": "B01LXSB86V",
    "upc": "012000001574",
    "gtin": "012000001574",
    "title": "Aquafina Water Bottle, 1 L",
    "brand": "AQUAFINA",
    "subBrand": "Water Bottle,",
    "vol": "Aquafina 1L",
    "packType": "Aquafina 1L",
    "packCount": "1",
    "unitCost": "0.97",
    "srp": "1.60",
    "cogs": "11.64",
    "rsvPy": "25338",
    "rsvYtd": "1223",
    "rsvFinancePackSize2024": "Aquafina 1L",
    "resetDate": "03/01/25",
    "inMarketDate": "10/06/25",
    "tags": [],
    "regions": [
      "Southeast"
    ],
    "lastUpdated": "04/14/26 10:15AM",
    "conflict": false,
    "category": "water",
    "subCategory": "still water",
    "form": "bottle"
  },
  {
    "id": 39,
    "status": "hub-active",
    "bu": "QUAKER",
    "customer": "Walmart",
    "vendor": "PEPQU",
    "sku": "B08XD6PL22",
    "upc": "030000572405",
    "gtin": "10030000572402",
    "title": "IQO Express Cup Maple Brown Sugar 4ct",
    "brand": "IQO EXPRESS CUPS",
    "subBrand": "Express Cup",
    "vol": "IQO EXP CUP 6.7OZ 4PK/6CS MBS",
    "packType": "OATMEAL EXPRESS,XSMALL,6-1-4",
    "packCount": "12",
    "unitCost": "2.01",
    "srp": "5.19",
    "cogs": "12.05",
    "rsvPy": "96678",
    "rsvYtd": "17113",
    "rsvFinancePackSize2024": "OATMEAL EXPRESS,XSMALL,6-1-4",
    "resetDate": "04/15/25",
    "inMarketDate": "11/02/25",
    "tags": [
      "Low ASP"
    ],
    "regions": [
      "West",
      "Midwest"
    ],
    "lastUpdated": "04/27/26 3:59PM",
    "conflict": false,
    "category": "breakfast",
    "subCategory": "other breakfast",
    "form": "box"
  },
  {
    "id": 40,
    "status": "unknown",
    "bu": "PBNA",
    "customer": "Catalog",
    "vendor": "PEQF9",
    "sku": "B01NALEPG6",
    "upc": "012000161162",
    "gtin": "012000161162",
    "title": "LIFEWTR, Premium Purified Water, pH Balanced with Electrolytes, 700 mL",
    "brand": "LIFEWTR",
    "subBrand": "Premium Purified",
    "vol": "LifeWTR Total700ml 12L",
    "packType": "LifeWTR Total700ml 12L",
    "packCount": "8",
    "unitCost": "0.90",
    "srp": "1.99",
    "cogs": "10.80",
    "rsvPy": "30597",
    "rsvYtd": "1981",
    "rsvFinancePackSize2024": "LifeWTR Total700ml 12L",
    "resetDate": "06/01/25",
    "inMarketDate": "01/11/26",
    "tags": [],
    "regions": [
      "National"
    ],
    "lastUpdated": "06/18/26 2:51PM",
    "conflict": false,
    "category": "water",
    "subCategory": "still water",
    "form": "bottle"
  },
  {
    "id": 41,
    "status": "active",
    "bu": "FLNA",
    "customer": "Amazon.com",
    "vendor": "FRIT1",
    "sku": "B00TQFINTK",
    "upc": "028400372183",
    "gtin": "028400372183",
    "title": "Lay's Kettle Cooked Mesquite BBQ Flavred Potato Chips, 8 Ounce",
    "brand": "Lay's Kettle",
    "subBrand": "Kettle Cooked",
    "vol": "XL",
    "packType": "TAKE HOME (REGULAR)",
    "packCount": "8",
    "unitCost": "3.16",
    "srp": "4.29",
    "cogs": "44.24",
    "rsvPy": "54703",
    "rsvYtd": "14487",
    "rsvFinancePackSize2024": "TAKE HOME (REGULAR)",
    "resetDate": "07/15/25",
    "inMarketDate": "02/09/26",
    "tags": [],
    "regions": [
      "Pacific Northwest",
      "Midwest",
      "Southeast"
    ],
    "lastUpdated": "06/25/26 7:45AM",
    "conflict": false,
    "category": "salty snacks",
    "subCategory": "other snacks",
    "form": "chip"
  },
  {
    "id": 42,
    "status": "active",
    "bu": "FLNA",
    "customer": "Amazon Fresh",
    "vendor": "FRIT1",
    "sku": "B000UEP57O",
    "upc": "028400183826",
    "gtin": "028400183826",
    "title": "Lay's Oven Baked Original Potato Crisps, 6.25 Ounce",
    "brand": "LAY'S BAKED",
    "subBrand": "Oven Baked",
    "vol": "XL",
    "packType": "TAKE HOME (REGULAR)",
    "packCount": "24",
    "unitCost": "3.67",
    "srp": "4.99",
    "cogs": "29.36",
    "rsvPy": "239579",
    "rsvYtd": "70360",
    "rsvFinancePackSize2024": "TAKE HOME (REGULAR)",
    "resetDate": "09/01/25",
    "inMarketDate": "03/23/26",
    "tags": [
      "Low ASP",
      "Innovation 2025"
    ],
    "regions": [
      "Pacific Northwest",
      "West"
    ],
    "lastUpdated": "02/18/26 9:25PM",
    "conflict": false,
    "category": "salty snacks",
    "subCategory": "other snacks",
    "form": "chip"
  },
  {
    "id": 43,
    "status": "upc-changes",
    "bu": "QUAKER",
    "customer": "Walmart",
    "vendor": "PEPQU",
    "sku": "B0955LZR7S",
    "upc": "030000659403",
    "gtin": "10030000659400",
    "title": "Pearl Milling Company Butter Rich Syrup, 24oz, 24 Oz",
    "brand": "PEARL MILLING COMPANY",
    "subBrand": "Milling Company",
    "vol": "PRLMLGCO SYRUP RICH 24OZ 12CS BUTTER",
    "packType": "PEARL MILLING CO SYRUP,LARGE,12-1-1",
    "packCount": "8",
    "unitCost": "3.48",
    "srp": "2.29",
    "cogs": "41.76",
    "rsvPy": "6369",
    "rsvYtd": "0",
    "rsvFinancePackSize2024": "PEARL MILLING CO SYRUP,LARGE,12-1-1",
    "resetDate": "10/15/25",
    "inMarketDate": "05/18/26",
    "tags": [],
    "regions": [
      "National"
    ],
    "lastUpdated": "02/18/26 5:49AM",
    "conflict": true,
    "category": "breakfast",
    "subCategory": "pancake mix",
    "form": "box",
    "statusClass": "upcchanges",
    "upcOld": "030000659403",
    "upcNew": "030000659999",
    "upcChangeDate": "03/15/26",
    "upcChangeReason": "Package redesign"
  },
  {
    "id": 44,
    "status": "active",
    "bu": "FLNA",
    "customer": "Catalog",
    "vendor": "FRIT1",
    "sku": "B0015IX8RI",
    "upc": "028400705639",
    "gtin": "028400705639",
    "title": "Baken-ets Fried Pork Skins, Hot & Spicy, 4 oz",
    "brand": "BAKEN-ETS",
    "subBrand": "Fried Pork",
    "vol": "XXVL",
    "packType": "SINGLE SERVE",
    "packCount": "10",
    "unitCost": "2.20",
    "srp": "2.99",
    "cogs": "33.00",
    "rsvPy": "34572",
    "rsvYtd": "16444",
    "rsvFinancePackSize2024": "SINGLE SERVE",
    "resetDate": "01/15/26",
    "inMarketDate": "06/22/26",
    "tags": [],
    "regions": [
      "National"
    ],
    "lastUpdated": "01/18/26 2:59PM",
    "conflict": false,
    "category": "salty snacks",
    "subCategory": "other snacks",
    "form": "chip"
  },
  {
    "id": 45,
    "status": "discontinued",
    "bu": "QUAKER",
    "customer": "Amazon.com",
    "vendor": "PEPQU",
    "sku": "B09YFJR51S",
    "upc": "030000568583",
    "gtin": "10030000568580",
    "title": "Quaker Instant Grits, Cheese Lovers Variety Pack, 10 Packets",
    "brand": "GRITS",
    "subBrand": "Instant Grits,",
    "vol": "QIG 9.8OZ/12CS CHEESE LOVERS VP - PO",
    "packType": "QUAKER INSTANT GRITS,SMALL,12-1-10",
    "packCount": "24",
    "unitCost": "3.19",
    "srp": "2.86",
    "cogs": "38.33",
    "rsvPy": "0",
    "rsvYtd": "0",
    "rsvFinancePackSize2024": "QUAKER INSTANT GRITS,SMALL,12-1-10",
    "resetDate": "03/01/26",
    "inMarketDate": "08/03/26",
    "tags": [
      "Low ASP",
      "Innovation 2026"
    ],
    "regions": [
      "Midwest",
      "Southwest",
      "West"
    ],
    "lastUpdated": "07/20/26 9:25AM",
    "conflict": false,
    "category": "hot cereals",
    "subCategory": "grits",
    "form": "packet",
    "discoDate": "11/15/26"
  },
  {
    "id": 46,
    "status": "hub-active",
    "bu": "QUAKER",
    "customer": "Amazon Fresh",
    "vendor": "PEPQU",
    "sku": "B0CR1YSKF9",
    "upc": "030000578339",
    "gtin": "10030000578336",
    "title": "Quaker Protein Bars:  Cookies & Cr\u00e8me 12 ct",
    "brand": "QUAKER PROTEIN BARS",
    "subBrand": "Protein Bars:",
    "vol": "QUAKER PROTEIN CHEWY 40G 5CT12CS CNC",
    "packType": "PROTEIN BAR,LARGE,12-1-5",
    "packCount": "12",
    "unitCost": "4.15",
    "srp": "1.79",
    "cogs": "49.85",
    "rsvPy": "0",
    "rsvYtd": "0",
    "rsvFinancePackSize2024": "PROTEIN BAR,LARGE,12-1-5",
    "resetDate": "04/15/26",
    "inMarketDate": "01/11/25",
    "tags": [
      "Fusion"
    ],
    "regions": [
      "Midwest",
      "Southeast"
    ],
    "lastUpdated": "04/12/26 10:27PM",
    "conflict": false,
    "category": "snack bars",
    "subCategory": "granola bars",
    "form": "bar"
  },
  {
    "id": 47,
    "status": "pipeline",
    "bu": "FLNA",
    "customer": "Walmart",
    "vendor": "FRIT1",
    "sku": "B0FRSGZXZ7",
    "upc": "028400794428",
    "gtin": "B0FRSGZXZ7",
    "title": "Good Warrior Original Beef Sticks",
    "brand": "Good Warrior",
    "subBrand": "Warrior Original",
    "vol": "EACH",
    "packType": "EACH",
    "packCount": "1",
    "unitCost": "1.79",
    "srp": "2.99",
    "cogs": null,
    "rsvPy": null,
    "rsvYtd": null,
    "rsvFinancePackSize2024": "EACH",
    "resetDate": "06/01/26",
    "inMarketDate": "02/16/25",
    "tags": [
      "Innovation 2025"
    ],
    "regions": [
      "Southwest"
    ],
    "lastUpdated": "01/11/26 10:15AM",
    "conflict": false,
    "category": "salty snacks",
    "subCategory": "other snacks",
    "form": "chip"
  },
  {
    "id": 48,
    "status": "hub-active",
    "bu": "QUAKER",
    "customer": "Catalog",
    "vendor": "PEPQU",
    "sku": "B0CNBQSQFD",
    "upc": "030000576106",
    "gtin": "10030000576103",
    "title": "Quaker Protein Granola, Maple Brown Sugar, 18oz",
    "brand": "PROTEIN GRANOLA",
    "subBrand": "Protein Granola,",
    "vol": "QUAKER PROTEIN GRANOLA MBS 18OZ 10CT",
    "packType": "QUAKER NATURAL CEREAL,LARGE,10-1-1",
    "packCount": "12",
    "unitCost": "5.24",
    "srp": "6.49",
    "cogs": "52.40",
    "rsvPy": "6272",
    "rsvYtd": "3311",
    "rsvFinancePackSize2024": "QUAKER NATURAL CEREAL,LARGE,10-1-1",
    "resetDate": "09/01/26",
    "inMarketDate": "03/23/25",
    "tags": [
      "Overlap ASIN",
      "Innovation 2026"
    ],
    "regions": [
      "National"
    ],
    "lastUpdated": "01/10/26 2:30PM",
    "conflict": false,
    "category": "cold cereals",
    "subCategory": "granola",
    "form": "bag"
  },
  {
    "id": 49,
    "status": "lto",
    "bu": "FLNA",
    "customer": "Amazon.com",
    "vendor": "FRIT1",
    "sku": "B0CX64W6TB",
    "upc": "028400744935",
    "gtin": "B0CX64W6TB",
    "title": "Jack Links Dorito Taco & Stick LTO",
    "brand": "Jack Links",
    "subBrand": "Links Dorito",
    "vol": "Each",
    "packType": "",
    "packCount": "120",
    "unitCost": "1.07",
    "srp": "1.79",
    "cogs": null,
    "rsvPy": null,
    "rsvYtd": null,
    "rsvFinancePackSize2024": "",
    "resetDate": "01/15/25",
    "inMarketDate": "05/05/25",
    "tags": [
      "Fusion"
    ],
    "regions": [
      "Southeast"
    ],
    "lastUpdated": "07/19/26 3:18AM",
    "conflict": false,
    "category": "salty snacks",
    "subCategory": "other snacks",
    "form": "chip"
  },
  {
    "id": 50,
    "status": "hub-active",
    "bu": "FLNA",
    "customer": "Amazon Fresh",
    "vendor": "FRIT1",
    "sku": "B0G75H98CV",
    "upc": "028400800174",
    "gtin": "28400800174",
    "title": "Simply Ruffles Hot & Spicy 5.5oz",
    "brand": "SIMPLY",
    "subBrand": "Ruffles Hot",
    "vol": "XXL",
    "packType": "TAKE HOME (REGULAR)",
    "packCount": "6",
    "unitCost": "2.79",
    "srp": "3.99",
    "cogs": "47.43",
    "rsvPy": "0",
    "rsvYtd": "140",
    "rsvFinancePackSize2024": "TAKE HOME (REGULAR)",
    "resetDate": "03/01/25",
    "inMarketDate": "06/15/25",
    "tags": [],
    "regions": [
      "West",
      "Southwest",
      "Northeast"
    ],
    "lastUpdated": "07/13/26 5:21AM",
    "conflict": true,
    "category": "salty snacks",
    "subCategory": "other snacks",
    "form": "chip"
  },
  {
    "id": 51,
    "status": "hub-active",
    "bu": "PBNA",
    "customer": "Walmart",
    "vendor": "PGTR1",
    "sku": "B072P1L8TQ",
    "upc": "876063007870",
    "gtin": "876063007870",
    "title": "EVOLVE Ideal Vanilla Protein Shake 4Pk, 11 FZ",
    "brand": "Evolve",
    "subBrand": "Ideal Vanilla",
    "vol": "4 CT 11 OZ",
    "packType": "Protein RTD",
    "packCount": "1",
    "unitCost": "8.39",
    "srp": "10.24",
    "cogs": "33.56",
    "rsvPy": "82315",
    "rsvYtd": "13239",
    "rsvFinancePackSize2024": "Protein RTD",
    "resetDate": "04/15/25",
    "inMarketDate": "08/19/25",
    "tags": [
      "Fusion"
    ],
    "regions": [
      "National"
    ],
    "lastUpdated": "09/19/26 5:56PM",
    "conflict": false,
    "category": "beverages",
    "subCategory": "other beverages",
    "form": "can"
  }
];









// ============================================================================
// TAG MODAL MANAGER
// ============================================================================
// ============================================================================
const TagModalManager = {
    selectedRowIds: [],
    stagedTags: new Set(),

    init() {
        this.overlay = document.getElementById('tagModalOverlay');
        this.closeBtn = document.getElementById('closeTagModalBtn');
        this.cancelBtn = document.getElementById('cancelTagModalBtn');
        this.applyBtn = document.getElementById('applyTagModalBtn');
        this.searchInput = document.getElementById('tagModalSearch');
        this.contentArea = document.getElementById('tagModalContent');
        this.selectedCountBadge = document.getElementById('tagModalSelectedCount');
        this.applyCountText = document.getElementById('tagModalApplyCount');
        this.warningBanner = document.getElementById('tagModalWarning');
        this.sharedNamesSpan = document.getElementById('sharedTagNames');

        this.bindEvents();
    },

    bindEvents() {
        // Find Tag button by ID
        const mainTagBtn = document.getElementById('openTagModalBtn');
        if (mainTagBtn) {
            mainTagBtn.addEventListener('click', () => {
                const selectedItems = Array.from(DataStore.state.selection);
                
                if (selectedItems.length === 0) {
                    alert("Please select at least one item to tag.");
                    return;
                }
                this.open(selectedItems);
            });
        }

        if (this.closeBtn) this.closeBtn.addEventListener('click', () => this.close());
        if (this.cancelBtn) this.cancelBtn.addEventListener('click', () => this.close());
        
        if (this.applyBtn) {
            this.applyBtn.addEventListener('click', () => {
                this.applyTags();
            });
        }

        if (this.searchInput) {
            this.searchInput.addEventListener('input', (e) => {
                this.renderTags(e.target.value);
            });
        }

        if (this.contentArea) {
            this.contentArea.addEventListener('click', (e) => {
                const chip = e.target.closest('.tag-select-chip');
                if (!chip || chip.classList.contains('disabled')) return;

                const tagId = chip.dataset.id;
                if (this.stagedTags.has(tagId)) {
                    this.stagedTags.delete(tagId);
                } else {
                    this.stagedTags.add(tagId);
                }
                this.updateApplyButton();
                this.renderTags(this.searchInput.value);
            });
        }
    },

    open(selectedRowIds) {
        this.selectedRowIds = selectedRowIds;
        this.stagedTags.clear();
        this.searchInput.value = '';
        
        // Pre-select tags already assigned to ALL selected items (intersection)
        if (selectedRowIds.length > 0) {
            const selectedItems = selectedRowIds.map(sku => DataStore.state.items.find(i => i.sku === sku)).filter(Boolean);
            if (selectedItems.length > 0) {
                const firstTags = new Set(selectedItems[0].tags || []);
                // Keep only tags present in ALL selected items
                const commonTags = [...firstTags].filter(tid => 
                    selectedItems.every(item => (item.tags || []).includes(tid))
                );
                commonTags.forEach(tid => this.stagedTags.add(tid));
            }
        }
        this.initialTags = new Set(this.stagedTags); // snapshot to detect adds/removes
        
        this.selectedCountBadge.textContent = `${selectedRowIds.length} items selected`;
        this.updateApplyButton();
        this.renderTags('');
        this.overlay.style.display = 'flex';
        
        if (window.lucide) lucide.createIcons();
    },

    close() {
        this.overlay.style.display = 'none';
        this.selectedRowIds = [];
        this.stagedTags.clear();
    },

    applyTags() {
        const tagsToAdd = [...this.stagedTags].filter(tid => !this.initialTags.has(tid));
        const tagsToRemove = [...this.initialTags].filter(tid => !this.stagedTags.has(tid));

        this.selectedRowIds.forEach(sku => {
            const item = DataStore.state.items.find(i => i.sku === sku);
            if (item) {
                if (!item.tags) item.tags = [];
                tagsToAdd.forEach(tid => {
                    if (!item.tags.includes(tid)) item.tags.push(tid);
                });
                tagsToRemove.forEach(tid => {
                    item.tags = item.tags.filter(t => t !== tid);
                });
            }
        });

        this.close();
        DataStore.state.selection.clear();
        UIManager.updateUI();
    },

    updateApplyButton() {
        const added = [...this.stagedTags].filter(tid => !this.initialTags || !this.initialTags.has(tid)).length;
        const removed = this.initialTags ? [...this.initialTags].filter(tid => !this.stagedTags.has(tid)).length : 0;
        const changes = added + removed;
        this.applyCountText.textContent = changes > 0 ? `${changes} tag change${changes > 1 ? 's' : ''} to apply` : '0 tags to apply';
        this.applyBtn.disabled = false; // always allow closing
    },

    renderTags(searchQuery) {
        const query = searchQuery.toLowerCase();
        
        const filteredTags = TagManager.library.filter(tag => 
            tag.label.toLowerCase().includes(query)
        );

        // Hide warning banner (no channels)
        if (this.warningBanner) this.warningBanner.style.display = 'none';

        let html = '<div class="channel-tags">';
        
        filteredTags.forEach(tag => {
            const isActive = this.stagedTags.has(tag.id);
            const activeClass = isActive ? 'active' : '';

            html += `
                <div class="tag-select-chip tag-theme-default ${activeClass}" data-id="${tag.id}">
                    ${tag.label}
                </div>
            `;
        });

        html += '</div>';

        this.contentArea.innerHTML = filteredTags.length > 0 ? html : '<div style="color: var(--muted-text); padding: 20px; text-align: center;">No tags found.</div>';
        
        if (window.lucide) lucide.createIcons();
    }
};

// ============================================================================
// INICIALIZACIÓN
// ============================================================================
function updateKPIs() {
    const items = DataStore.state.items || [];
    const total = items.length;
    const active = items.filter(i => i.status === 'active' || i.status === 'hub-active').length;
    const pipeline = items.filter(i => i.status === 'pipeline').length;
    const lto = items.filter(i => i.status === 'lto').length;
    const fmt = n => n.toLocaleString();
    const el = id => document.getElementById(id);
    if (el('kpi-total')) el('kpi-total').textContent = fmt(total);
    if (el('kpi-active')) el('kpi-active').textContent = fmt(active);
    if (el('kpi-pipeline')) el('kpi-pipeline').textContent = fmt(pipeline);
    if (el('kpi-lto')) el('kpi-lto').textContent = fmt(lto);
}

document.addEventListener('DOMContentLoaded', () => {
    try {
        DataStore.init(tableData);
        UIManager.updateUI();
        EventHandler.init();
        TagModalManager.init();
        updateKPIs();
        console.log('✓ Application initialized successfully (V2)');
    } catch (error) {
        console.error('Fatal initialization error:', error.stack);
        UIManager.showError('Application failed to initialize');
    }
});

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DataStore, DataAccessor, UIManager, EventHandler, Validators, FilterStrategies, PaginationEngine };
}
