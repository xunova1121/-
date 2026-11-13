/** 复用模型工作台的本机/云端patch，选项留空时不增加服务商参数。 */
export function imagePreferences({ cfg, workspace, node, run }) {
  const choices = [
    [
      'editFormat',
      '原图编辑格式',
      [
        ['', '自动（按型号）'],
        ['json', 'JSON原片（GPT 2.6等）'],
        ['multipart', '文件上传（兼容旧接口）']
      ]
    ],
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
        'GPT Image可使用画质、格式和背景选项；其他型号请保留默认。GPT 2.5/2.6默认用JSON传原片，旧型号保留文件上传；中转要求不同可明确切换。不会额外上传到图床，也不自动换格式重提收费编辑。高画质可能增加费用和耗时；实际能力以服务商为准。'
    })
  );
}
