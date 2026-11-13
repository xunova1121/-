/** 只识别用户的修图要求，不把选软件/谈开发的问题当照片编辑。 */
export function isPortraitRetouch(text = '') {
  const value = String(text).split('\n\n[已上传到工作区：')[0];
  if (/什么是|是什么|(?:怎么|如何|怎样).{0,8}(?:实现|开发|接入|调用|收费|计费)|(?:软件|相机|工具|功能).{0,8}(?:推荐|对比|比较|原理|价格)|(?:推荐|对比|比较).{0,8}(?:软件|相机|工具)/i.test(value)) return false;
  return /人像(?:美化|优化|修图|精修)|美颜|美肤|磨皮|祛痘|去痘|去斑|淡斑|瘦脸|瘦身|显瘦|[pPＰｐ] ?(?:瘦|白|美)|修瘦|瘦一点|瘦一?点儿|自然修图|照片精修/.test(value);
}

/** 修图指令优先于旧海报表单；明确还要制作海报时仍保留海报设置。 */
export function isStandalonePortraitRetouch(text = '') {
  const value = String(text).split('\n\n[已上传到工作区：')[0];
  return isPortraitRetouch(value) && !/海报|宣传图|封面|请柬|展板|展架|易拉宝/.test(value);
}
