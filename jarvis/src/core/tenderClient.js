export function createTenderClient(request) {
  return {
    list: (filters = {}) => request('/api/tenders/catalog?' + new URLSearchParams(filters)),
    mine: () => request('/api/tenders/mine'),
    change: body => request('/api/tenders/mine', { method: 'PATCH', body }),
    refresh: () => request('/api/tenders/refresh', { method: 'POST', body: {} }),
    configure: enabled => request('/api/tenders/settings', { method: 'PATCH', body: { enabled } })
  };
}
