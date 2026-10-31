/** 复用模型工作台的本机/云端patch，选项留空时不增加服务商参数。 */
export function imagePreferences({ cfg, workspace, node, run }) {
  const choices = [
    [
      'quality',
      '画图画质',
      [
        ['', '跟随服务商'],
        ['low', '低'],
        ['medium', '中'],
        ['high', '高']
      ]
    ],
    [
      'outputFormat',
      '图片格式',
      [
        ['', '跟随服务商'],
        ['png', 'PNG'],
        ['jpeg', 'JPEG'],
        ['webp', 'WebP']
      ]
    ],
    [
      'background',
      '图片背景',
      [
        ['', '跟随服务商'],
        ['opaque', '不透明'],
        ['transparent', '透明']
      ]
    ]
  ];
  return node(
    'div',
    { className: 'ml-image-options' },
    ...choices.map(([key, title, values]) => {
      const select = node(
        'select',
        { className: 'ml-ability-select', ariaLabel: title },
        ...values.map(([value, textContent]) => node('option', { value, textContent }))
      );
      select.value = cfg.imageOptions?.[key] || '';
      select.addEventListener('change', () =>
        run(() => workspace.patch((current) => ({ ...current, imageOptions: { ...current.imageOptions, [key]: select.value } })))
      );
      return node('label', { className: 'ml-ability-slot' }, node('span', { textContent: title }), select);
    }),
    node('small', {
      className: 'ml-ability-now',
      textContent:
        'GPT Image可使用以上选项；其他型号请保留默认。高画质可能增加费用和耗时。GPT Image 2可在上方手动填写；服务商是否提供须实际确认。编辑和结果未知的生成不会自动重提。'
    })
  );
}
