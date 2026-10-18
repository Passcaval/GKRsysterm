# 夜航美术资产与动效

制作日期：2026-10-18。使用内置 image_gen 生成，透明背景 PNG 原样保留。未使用外部图库或视频生成服务。

v0.3新增的星夜插画、划船逐帧素材与本地WebM视频，详见 [院校回声页美术与划船视频](ECHO-ASSETS.md)，包含文件位置、制作方式、复现脚本及完整提示词。

| 文件                         | 用途                         |
| ---------------------------- | ---------------------------- |
| `src/assets/voyager.png`     | 启航页：船上手持星图的人物   |
| `src/assets/lighthouse.png`  | 启航页：灰金色发光灯塔       |
| `src/assets/voyager-top.png` | 星图：俯视船与人物的位置标记 |

金色光束由 SVG 渐变与柔化滤镜实时绘制，ResizeObserver 与动画帧测量保持灯室与手持星图的连线对齐。船与人物一起轻微上下漂浮、左右摆动，星图中的俯视船只也有轻微漂浮。点击星图使用 Web Animations API 将镜头推近星图，转场时固定当前漂浮姿态，再过渡到院校星图；支持键盘激活，减少动效模式直接进入页面。无需下载或播放视频。

院校星体使用局部径向金色渐变，鼠标接近时增强亮度；键盘焦点也有金色光圈。全站导航默认隐藏，可从左上角按钮悬停或点击唤起，展开和收起带滑动、淡入淡出动效。系统减少动效设置会停用漂浮及过渡动画。

单文件预览通过 data URL 内嵌 PNG；标准 Vite 构建生成独立带哈希的资源。更新后执行 `pnpm run build` 与 `pnpm run standalone`。

## 生成提示词（完整原文）

### voyager

Use case: illustration-story. Asset type: transparent cutout hero illustration for Night Voyage university guidance website. Primary request: a small gender-neutral young adult sitting inside a slender small wooden rowboat, holding an OPEN unfolded star chart clearly in both hands at chest/lap level, attentively reading it. Style: exquisite restrained minimalist editorial illustration, sculptural paper-cut forms, soft charcoal graphite gray coat and boat, muted warm antique gold accents, subtle fine grain, elegant simple silhouette, no cartoon outline, not photorealistic, no text or logo. Composition: entire boat and person centered, wide horizontal silhouette with comfortable transparent margins; three-quarter side view, boat bow to right, person at center-left, open ivory gold star chart at center-right at roughly x=55%, y=43% of subject bounds. Important: map surface visible and large enough to serve as an interactive hotspot. Lighting: soft warm gold light arriving from upper right lights the chart and hands, restrained highlights on face and boat edge. Transparent background, isolated person + boat + chart ONLY, no water, no scenery, no cast shadow rectangle, no border, no text, no watermark. Palette harmonizes with navy #101a2b, gold #dfc28b and gray #77818d.

### lighthouse

Use case: illustration-story. Asset type: transparent cutout lighthouse illustration for Night Voyage website. Primary request: a single elegant tall lighthouse on a very small rocky base, its lantern glowing warm pale gold. Style: restrained minimalist editorial illustration, sculptural paper-cut forms and softly shaded graphite gray stone, subtle fine grain, muted antique gold trim, refined simple silhouette matching a gray-cloaked voyager in wooden rowboat. Composition: full lighthouse upright centered, tall narrow silhouette with generous transparent margin, front three-quarter view. Lantern at about 18% of subject height. Lantern windows should visibly glow gold; light emission points to the left, but DO NOT paint a long light beam: website code will draw and animate a precise gold light beam connecting lantern to voyager's hands. Keep all background truly transparent. Isolated lighthouse and small rock base ONLY. No water, sky, rectangle, scene background, text, logo, border or watermark. Palette navy #101a2b, warm gold #dfc28b, stone charcoal gray #77818d. Quiet poetic night-navigation mood.

### voyager-top

Use case: illustration-story. Asset type: tiny transparent position-marker sprite for a university constellation map. Primary request: directly overhead, true top-down 90 degree bird's-eye view of a small person sitting in the center of a slender wooden rowboat and holding an unfolded warm ivory star chart in their hands. Boat is oriented vertically with pointed bow towards top of image. Person has a simple charcoal-gray coat, round dark head, small hands around gold chart. Entire boat seen from directly above, NOT isometric, no horizon. Style: refined minimalist editorial paper-cut illustration, graphite gray hull with antique gold gunwale, muted warm gold details, subtle fine grain, clear legible silhouette at only 70px tall. Isolated boat, seated person and chart ONLY on genuinely transparent background. No water, ripple, shadows outside silhouette, scenery, letters, text, logo or watermark. Color palette harmonizes with dark navy #101a2b, gold #dfc28b, gray #77818d. Full object within image with comfortable margin.
