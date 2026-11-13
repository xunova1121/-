const measure = text => [...text].reduce((sum, c) => sum + (/[\u0000-\u007f]/.test(c) ? 0.58 : 1), 0) * 12;
export const labelBox = position => ({ x: position.x, y: position.y - 12, width: position.width, height: position.height });
export const boxesOverlap = (a, b) => a.x < b.x + b.width + 2 && a.x + a.width > b.x - 2 && a.y < b.y + b.height + 2 && a.y + a.height > b.y - 2;
export const routeHitsBox = (a, b, box) => a.x === b.x
  ? a.x > box.x - 2 && a.x < box.x + box.width + 2 && Math.max(a.y,b.y) > box.y - 2 && Math.min(a.y,b.y) < box.y + box.height + 2
  : a.y > box.y - 2 && a.y < box.y + box.height + 2 && Math.max(a.x,b.x) > box.x - 2 && Math.min(a.x,b.x) < box.x + box.width + 2;
/** 每候选最多6个标签位置；与对象/标题、已有标签和已有连线一起避让，不覆盖文字或静默删标签。 */
export function routeLabelPosition(points, label, { boxes, labels, routes, width: canvasWidth }) {
  const measured = measure(label), width = Math.min(measured,84)+4, height = measured > 84 ? 34 : 18;
  const safe = position => {
    const rect = labelBox({ ...position, width, height });
    return rect.x >= 8 && rect.x + width <= canvasWidth - 8 && !boxes.some(box=>boxesOverlap(rect,box)) && !labels.some(box=>boxesOverlap(rect,box)) && !routes.some(route=>route.some((point,index)=>index && routeHitsBox(route[index-1],point,rect)));
  };
  const segments=points.slice(1).map((end,index)=>({start:points[index],end}));
  const horizontal=segments.filter(segment=>segment.start.y===segment.end.y && Math.abs(segment.start.x-segment.end.x)>Math.min(measured,84)+16)
    .sort((a,b)=>Math.abs(b.start.x-b.end.x)-Math.abs(a.start.x-a.end.x));
  for(const {start,end} of horizontal){
    const y=start.y-(measured>84?30:14);
    for(const x of [(start.x+end.x)/2-Math.min(measured,84)/2,Math.min(start.x,end.x)+8,Math.max(start.x,end.x)-width-8])
      if(safe({x,y}))return {x,y,width,height,maxLines:2};
  }
  for(const {start,end} of segments){
    if(start.x!==end.x || Math.abs(start.y-end.y)<height+4)continue;
    const min=Math.min(start.y,end.y),max=Math.max(start.y,end.y);
    for(const y of [min+height-3,(min+max)/2,max-5])for(const x of [start.x+8,start.x-width-8]){
      const rect=labelBox({x,y,width,height});
      if(rect.y>=min && rect.y+height<=max && safe({x,y}))return {x,y,width,height,maxLines:2};
    }
  }
  return null;
}
