/** 只读有界要求头部；固定规则由程序提供，不执行材料里的指令。 */
export function styleRequest(text, expressions) {
  const header = String(text || '').slice(0, 12000).split(/^#{1,6}\s/m)[0];
  const events = [];
  for (const [style, expression] of expressions) {
    for (const match of header.matchAll(new RegExp(expression.source, expression.flags))) {
      const prefix = header.slice(0, match.index).split(/[，,。；;\n]/).at(-1).slice(-120);
      const listedPrefix = expressions.reduce((value, [, re]) => value.replace(new RegExp(re.source, re.flags), ''), prefix).replace(/[、/和或与及\s]+$/, '');
      const negative = /(?:不要|不用|不想要|不喜欢|别用|别|不采用|避免)(?:再|用|采用|做成|选择|那种|这种|这个|太|那么|过于|的|\s)*$/.test(listedPrefix);
      events.push({ style, negative, at: match.index });
    }
  }
  let style = '';
  const excluded = new Set();
  for (const event of events.sort((a, b) => a.at - b.at)) {
    if (event.negative) {
      excluded.add(event.style);
      if (style === event.style) style = '';
    } else {
      excluded.delete(event.style);
      style = event.style;
    }
  }
  return { style, excluded: [...excluded] };
}
