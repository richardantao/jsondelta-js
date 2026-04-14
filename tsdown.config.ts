import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts", "src/react/index.ts"],
	outDir: "dist",
	format: ["esm"],
	minify: true,
	clean: true,
	target: "es2023",
	sourcemap: false,
	outputOptions: {
		chunkFileNames: "[name].js",
	},
});
