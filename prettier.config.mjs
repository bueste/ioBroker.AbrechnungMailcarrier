// iobroker prettier configuration file
import prettierConfig from "@iobroker/eslint-config/prettier.config.mjs";

export default {
    ...prettierConfig,
    // This repository has always used double quotes, an 80 column limit and parenthesised arrow
    // parameters; keep the formatting as it is instead of reformatting every file.
    singleQuote: false,
    printWidth: 80,
    arrowParens: "always",
    singleAttributePerLine: false,
};
