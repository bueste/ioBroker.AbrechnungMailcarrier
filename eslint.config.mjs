import iobrokerConfig from "@iobroker/eslint-config";

export default [
    ...iobrokerConfig,
    {
        rules: {
            // plain, well-commented JS - the code comments carry the explanation,
            // repeating it as a one-line JSDoc description per @param would just be noise.
            "jsdoc/require-jsdoc": "off",
            "jsdoc/require-param-description": "off",
            "jsdoc/require-returns-description": "off",
            // JSDoc type annotations (@type/@typedef) are used on purpose for "npm run check" (tsc).
            "jsdoc/check-tag-names": "off",
        },
    },
    {
        ignores: ["admin/build/", "test/**/*.js"],
    },
];
