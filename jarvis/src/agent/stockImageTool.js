export const stockImageTool = ctx => ({
  name:'search_stock_images',
  description:'为通用场景搜索并看图选择正版图库配图，下载到工作区，返回来源作者和许可。只用已通过国内检测的官方接口；不搜具体人物或新闻赛事现场。用户原图优先，未取得图片不能说搜图成功。',
  input_schema:{type:'object',properties:{query:{type:'string',maxLength:160,description:'通用场景，如球场、办公、农业、医院、城市、教室'}},required:['query'],additionalProperties:false},
  async run({query},{signal,retrieval}={}) {
    if(!ctx.stockImageForSlide)return JSON.stringify({state:'unavailable',note:'请在云服务器配置图库并完成国内检测；本端未取得图片'});
    const result=await ctx.stockImageForSlide({query,signal,retrieval});
    if(!result)return JSON.stringify({state:'empty',note:'没有通过许可和看图筛选的图片；可用用户原图、图表或概念插画'});
    ctx.onFileChanged?.(result.path);
    return JSON.stringify({state:'downloaded',...result});
  }
});
