# 院校回声页美术与划船视频

制作日期：2026-10-18。两张图片使用内置 image_gen 工具生成；划船视频由生成的八帧素材在本机编码完成，未调用 Runway 或其他视频生成模型，也不需要相应账号或密钥。

| 交付文件 | 用途 |
| --- | --- |
| `src/assets/campus-night.png` | 1536×1024，人物坐在船上手持星图、仰望星空；回声页主视觉 |
| `src/assets/rowing-sheet.png` | 1792×896，透明背景，4列×2行的俯视划船动作帧；视频源及播放失败时的替代动画 |
| `src/assets/rowing.webm` | 320×320，VP8/WebM，30fps，3.2秒，无音轨，约233KB；航行时循环播放 |
| `scripts/render-rowing.py` | 可复现的视频编码脚本；依赖Pillow、numpy、opencv-python |

原始生成PNG保留不变。视频将逐帧素材按每姿态6帧、两轮循环编码，属于八姿态的插画逐帧动画，不是视频模型生成的连续实拍动作。深蓝底配合网页径向遮罩融入星图；PNG备选动画保持透明。人物动作在视频中，目的地、位置、朝向、水纹和航线由页面控制，因而可准确对应任意院校位置。

星图航行时长约3.8秒。曲线从当前船位到所选院校坐标，返回星图后从最近停靠院校出发。用户可以跳过或取消；系统减少动效设置开启时直接进入目标回声页。视频仅在航行期间挂载，取消或离开星图即清理。

星夜插画之上叠加三颗错峰出现的流星，单次快速划过约一秒，尾迹为金色渐变。页面提供暂停/播放入口，减少动效时隐藏流星。流星层只覆盖天空且不拦截交互。

## 完整生成提示词

### campus-night（新图，非透明）

Use case: illustration-story. Asset type: wide hero artwork for Night Voyage university-specific campus letters page. Primary request: one young adult traveller in a small slender wooden boat at night, holding an open ivory star chart in their lap with both hands, lifting their head to gaze up at a vast starry sky. Medium: elegant restrained minimalist editorial illustration with sculptural paper-cut-like forms, soft graphite grey clothing, charcoal wood boat with muted antique gold trim, subtle grain; quiet poetic mood. Composition: wide landscape 3:2; small boat and seated traveller at lower right third, seen from rear three-quarter side so upward head gaze and open chart clearly readable. Huge spacious dark navy sky across upper 75%; few fine warm gold stars, subtle constellation lines. Calm dark navy water at bottom with delicate reflections; no land, no lighthouse, no buildings, no extra people. Color palette #101a2b navy, graphite #77818d, warm gold #dfc28b. Subdued edges blending into navy, no frames, NO text, logos, watermark. Important leave upper left and upper middle sky uncluttered for code-generated animated shooting stars; do not draw long meteor trails yourself.

### rowing-sheet（初始生成，透明）

Use case: illustration-story. Asset type: production sprite sheet for a tiny top-down rowboat character animation in Night Voyage university constellation webpage. Primary request: EXACT 8 animation frames arranged in a precise 4 columns x 2 rows uniform grid, each identical square cell, no gutters, no grid outlines. In every frame show the same small graphite wooden rowboat from directly overhead 90-degree bird's-eye view, bow pointing UP, stern DOWN; seated person in charcoal grey coat holding a pair of long antique gold wooden OARS and actively rowing. No chart in these frames. A continuous full rowing stroke over eight frames in reading order: oars sweep from forward/up-left and up-right to sideways to backward/down-left and down-right, then lift and return; person's forearms move with the oar handles. The boat hull and head must remain exactly fixed at the center and size of every cell, each boat hull height about 65% of cell height. All oars and hands fit fully inside each cell with transparent margins. Style: restrained minimalist sculptural editorial illustration, softly shaded graphite grey, fine subtle grain, muted gold gunwales and oars; crisp readable silhouettes suitable at 100px wide. Consistent lighting and proportions across frames, true transparent background everywhere outside boats. No water, wake, shadow rectangle, horizon, text, numerals, labels, borders, extra characters or objects. The entire sheet should be square and have genuine alpha transparency.

### rowing-sheet（最终间距修订，透明）

初版作为编辑目标，使用内置工具进行修订。提示词中的2048×1024是请求尺寸；实际工具输出1792×896，保持2:1比例，运行时根据实际尺寸划分八帧。

Edit target is the attached sprite sheet. Keep the same overhead boat/person/oars illustration, graphite and gold palette and transparent background. FIX THE GRID AND SPACING for usable animation: create a WIDE LANDSCAPE sheet, exact aspect ratio 2:1, requested 2048x1024 pixels, 4 columns by 2 rows of SQUARE 512x512 cells. Every boat hull centered at the center of its own cell, bow UP, fixed hull height ONLY 58% of cell height. Oars fully contained within each cell, including the sideways stroke. No part of any boat or oar may reach into a neighboring cell. Comfortable transparent padding between the subjects. Eight consecutive smooth rowing poses in reading order, from forward oar sweep to sideways to back sweep then recovery. No visible grid, numerals, labels, text, water or background. Exactly eight frames. Genuine alpha background.
