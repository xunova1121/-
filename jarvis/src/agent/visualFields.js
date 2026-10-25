/** 仅读取明确同一行的字段与读数，最多20条；不是识别置信度，不修正漏位或补零。 */
export function visualFields(text) {
  const fields = [];
  for (const line of String(text || '').slice(0, 24000).split('\n')) {
    const match = line.match(/(?:^|[|\s])(?:\*\*)?(CO[₂2]|HCHO|TVOC|PM2\.5|PM10|温度|湿度)(?:\*\*)?\s*[|：:]\s*(?:\*\*)?([+-]?\d+(?:\.\d+)?)\s*(ppm|ppb|mg\/m[³3]|μg\/m[³3]|ug\/m[³3]|℃|°C|%)?/i);
    if (!match) continue;
    fields.push({ label: match[1].toUpperCase().replace('₂', '2'), value: match[2], unit: match[3] || '' });
    if (fields.length === 20) break;
  }
  return fields;
}

export function visualFieldConflict(fields, answer) {
  const candidates = visualFields(answer);
  return fields.some(field => candidates.some(candidate => candidate.label === field.label && (candidate.value !== field.value || candidate.unit && field.unit && candidate.unit.toLowerCase() !== field.unit.toLowerCase())));
}
