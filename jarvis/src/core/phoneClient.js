export function createPhoneClient(request) {
  const root = '/api/phone/devices';
  return { list: () => request(root), register: body => request(root, { method: 'POST', body }), disconnect: id => request(root + '/' + encodeURIComponent(id), { method: 'DELETE' }) };
}
