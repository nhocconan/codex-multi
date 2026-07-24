declare const __PACKAGE_VERSION__: string;

export const VERSION =
  typeof __PACKAGE_VERSION__ === "string" ? __PACKAGE_VERSION__ : "0.2.1";
