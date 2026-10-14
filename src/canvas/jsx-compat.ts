// Names that canvases in the component format already use on disk. Cadence has
// to match them exactly to open those projects, so they live here, once.

/** The module the format's tags are imported from (and its root, which some files import from). */
export const JSX_TAG_IMPORT = "tempo-sdk/canvas";
export const JSX_TAG_MODULE = /^tempo-sdk(\/canvas)?$/;

/** The comment that marks a project's main canvas. */
export const JSX_HOME_MARKER = "@tempo-home";

/** The project settings file that names the app's dev command and URL. */
export const JSX_PROJECT_CONFIG = "tempo.config.json";
