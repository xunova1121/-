// 时刻以毫秒绝对值保存，显示时读取设备现在的时区。
export function localMinute(date) {
  return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}

export function localMessageTime(date, today = new Date()) {
  const prefix = date.toDateString() === today.toDateString() ? '' :
    (date.getFullYear() === today.getFullYear() ? '' : date.getFullYear() + '/') +
    (date.getMonth() + 1) + '/' + date.getDate() + ' ';
  return prefix + localMinute(date);
}
