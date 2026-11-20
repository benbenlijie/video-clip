import { referenceStyleSpec } from "./style-spec-v2.mjs";

export const referenceStyleSpecV3 = JSON.parse(JSON.stringify(referenceStyleSpec));
referenceStyleSpecV3.contract = "style-spec.v3";

for (const typography of [
  referenceStyleSpecV3.title.primary,
  referenceStyleSpecV3.title.secondary,
  referenceStyleSpecV3.identity.primary,
  referenceStyleSpecV3.identity.secondary,
  referenceStyleSpecV3.captions.typography,
]) {
  typography.fontFamily = "Noto Sans CJK SC";
  typography.fontId = "noto-sans-cjk-sc-black";
  typography.fontWidthScale = 0.92;
}

referenceStyleSpecV3.identity.offsetYRatio = 0.12;
referenceStyleSpecV3.identity.maxLines = 4;

