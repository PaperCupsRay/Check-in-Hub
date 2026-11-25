import packageInfo from "../package.json" with { type: "json" };

export const appVersion = packageInfo.version;
