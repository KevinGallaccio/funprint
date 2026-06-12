// Force 24-bit color BEFORE terminal-image (and its chalk dependency) is
// evaluated, so the preview always renders as colored half-blocks even when
// chalk's auto-detection is conservative (e.g. in Warp). ES module imports are
// evaluated in source order, so importing this first guarantees it runs before
// terminal-image computes its color level.
if (!process.env.FORCE_COLOR) process.env.FORCE_COLOR = "3";
