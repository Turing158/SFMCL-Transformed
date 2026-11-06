// Keep third-party OAuth implemented while provider applications are pending.
// Enable it for an approved build with VITE_SFMCL_T_THIRD_PARTY_OAUTH=true.
export const thirdPartyOAuthEnabled =
  import.meta.env.VITE_SFMCL_T_THIRD_PARTY_OAUTH === "true";

export const thirdPartyOAuthMenuLabel = thirdPartyOAuthEnabled
  ? "第三方授权登录"
  : "第三方授权登录（暂未开放）";
