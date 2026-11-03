`starfall-types.ttf` is copied unchanged from
`StarFallMC/assets/icon/iconfont.ttf` in the StarFall-Minecraft-Launcher project.

The resource center and Minecraft installation page share the same version
images. Ordinary Minecraft types use assets copied unchanged from StarFallMC:

- Release: `DefaultGameIcon/Minecraft.png` (grass block).
- Snapshot: `DefaultGameIcon/snapshot.png` (command block).
- Historical (`old_alpha` / `old_beta`): `element/bedrock.png`.
- Unknown type: `DefaultGameIcon/unknowGame.png`.

April Fools versions use the version-title images from the navbox
on [Minecraft Wiki's April Fools page](https://zh.minecraft.wiki/w/%E6%84%9A%E4%BA%BA%E8%8A%82%E7%8E%A9%E7%AC%91?variant=zh-cn),
downloaded unchanged on 2026-11-02 to `assets/minecraft/april-fools/`:

| Manifest version ID | Local file | Wiki source image |
| --- | --- | --- |
| `15w14a` | `15w14a.png` | [Obsidian boat](https://zh.minecraft.wiki/images/EntitySprite_boat-obsidian.png) |
| `1.RV-Pre1` | `1-rv-pre1.png` | [USB charger](https://zh.minecraft.wiki/images/BlockSprite_usb-charger.png) |
| `3D Shareware v1.34` | `3d-shareware-v1-34.png` | [3D](https://zh.minecraft.wiki/images/ItemSprite_3d.png) |
| `20w14infinite` (Wiki: `20w14∞`) | `20w14infinite.png` | [Netherite stairs](https://zh.minecraft.wiki/images/BlockSprite_netherite-stairs.png) |
| `22w13oneblockatatime` | `white-carpet-je2-be2.png` | [White Carpet JE2 BE2](https://zh.minecraft.wiki/w/File:White_Carpet_JE2_BE2.png) (user-selected override) |
| `23w13a_or_b` | `23w13a_or_b.png` | [The moon](https://zh.minecraft.wiki/images/EnvSprite_the-moon.png) |
| `24w14potato` | `24w14potato.png` | [Poisonous potato](https://zh.minecraft.wiki/images/ItemSprite_poison-potato.png) |
| `25w14craftmine` | `25w14craftmine.png` | [Mine crafter](https://zh.minecraft.wiki/images/BlockSprite_mine-crafter.png) |
| `26w14a` | `26w14a.png` | [Punch](https://zh.minecraft.wiki/images/ItemSprite_punch.png) |

`22w13oneblockatatime` uses the user-selected White Carpet JE2 BE2 image
instead of the navbox sprite. The original PNG is copied unchanged, with
pixelated scaling handled by the shared resource icon styles.

The original Minecraft artwork belongs to Mojang Studios; the links above
identify the individual source images. Images are bundled locally so the app
can display them offline.

April Fools IDs are matched case-insensitively before checking the manifest
type, so the Wiki's `22w13oneBlockAtATime` spelling resolves to the same image
as Mojang's `22w13oneblockatatime`. The nine installable April Fools versions
in the official manifest all have matching Wiki icons; there are no missing
icons as of the date above. A recognized April Fools ID without a specific
image retains `element/diamond_pickaxe.png` as its fallback. The icon font has
no R / S / O / N glyphs and is no longer used for these version icons.

`search1-9x9.png` is the user-provided 9×9 search icon, copied unchanged from
`StarFall-vue/src/assets/img/search1-9x9.png`. All search fields share this
asset as a theme-colored mask, rendered at 18×18 with pixelated scaling.
