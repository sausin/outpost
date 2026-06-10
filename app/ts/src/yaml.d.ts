/**
 * Wrangler's `[[rules]] type = "Text"` rule lets us import *.yaml files as
 * strings.  This module declaration teaches TypeScript about that.
 *
 * The Node adapter uses runtime fs.readFile and never hits these imports;
 * only the Workers adapter uses them so YAMLs ship in the bundle.
 */
declare module "*.yaml" {
  const content: string;
  export default content;
}

declare module "*.yml" {
  const content: string;
  export default content;
}
