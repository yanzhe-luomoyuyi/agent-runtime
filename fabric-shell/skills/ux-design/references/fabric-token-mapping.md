# Fabric Design Token Mapping

Map raw CSS values from Figma or captured UI to `@fabric-msft/theme` tokens. Every visual value in mockups and implementation **must** use `var(--tokenName, fallback)` — never raw hex/px.

## Token table

| CSS property | Fabric token family | Example mapping |
|---|---|---|
| `color`, `background-color` | `colorNeutral*`, `colorBrand*`, `colorStatus*` | `#242424` → `var(--colorNeutralForeground1, #242424)` |
| `font-size` | `fontSizeBase*` | `14px` → `var(--fontSizeBase300, 14px)` |
| `font-weight` | `fontWeight*` | `600` → `var(--fontWeightSemibold, 600)` |
| `line-height` | `lineHeightBase*` | `20px` → `var(--lineHeightBase300, 20px)` |
| `padding`, `margin`, `gap` | `spacingHorizontal*`, `spacingVertical*` | `12px` → `var(--spacingHorizontalM, 12px)` |
| `border-radius` | `borderRadius*` | `4px` → `var(--borderRadiusMedium, 4px)` |
| `box-shadow` | `shadow*` | → `var(--shadow4)` |
| `border-width` | `strokeWidth*` | `1px` → `var(--strokeWidthThin, 1px)` |

## Common color tokens

| Token | Light value | Usage |
|---|---|---|
| `colorNeutralForeground1` | `#242424` | Primary text |
| `colorNeutralForeground2` | `#616161` | Secondary text |
| `colorNeutralBackground1` | `#ffffff` | Page background |
| `colorNeutralBackground3` | `#f5f5f5` | Subtle background |
| `colorBrandBackground` | `#0f6cbd` | Primary action background |
| `colorBrandForeground1` | `#0f6cbd` | Links, brand text |
| `colorStatusDangerForeground1` | `#b10e1c` | Error text |
| `colorStatusSuccessForeground1` | `#0e7a0b` | Success text |

## Common spacing tokens

`spacingHorizontalNone` (0) · `spacingHorizontalXXS` (2px) · `spacingHorizontalXS` (4px) · `spacingHorizontalSNudge` (6px) · `spacingHorizontalS` (8px) · `spacingHorizontalM` (12px) · `spacingHorizontalL` (16px) · `spacingHorizontalXL` (20px) · `spacingHorizontalXXL` (24px)

Same pattern for `spacingVertical*`.

## Typography scale

| Token | Size | Line height token | Line height |
|---|---|---|---|
| `fontSizeBase100` | 10px | `lineHeightBase100` | 14px |
| `fontSizeBase200` | 12px | `lineHeightBase200` | 16px |
| `fontSizeBase300` | 14px | `lineHeightBase300` | 20px |
| `fontSizeBase400` | 16px | `lineHeightBase400` | 22px |
| `fontSizeBase500` | 20px | `lineHeightBase500` | 28px |
| `fontSizeBase600` | 24px | `lineHeightBase600` | 32px |
