// LittleSkin device authorization is approved and available by default.
// Set VITE_SFMCL_T_THIRD_PARTY_OAUTH=false to disable it for a build.
export const thirdPartyOAuthEnabled =
  import.meta.env.VITE_SFMCL_T_THIRD_PARTY_OAUTH !== "false";

export const thirdPartyOAuthMenuLabel = thirdPartyOAuthEnabled
  ? "LittleSkin登录"
  : "LittleSkin登录（暂未开放）";
