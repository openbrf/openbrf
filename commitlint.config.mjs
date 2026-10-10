export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    /*
     * CI lints every commit of a pull request, and Dependabot writes commit
     * bodies whose first line names the group, the directory and the package in
     * one sentence, well past 100 columns. A body is read by people, and a URL
     * or a package path is not made more readable by a line break; the header,
     * which changelog tooling reads, keeps its limit.
     */
    "body-max-line-length": [0],
  },
};
