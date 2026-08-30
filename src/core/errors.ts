export class RepositoryNotSupportedError extends Error {
  constructor(root: string, attempts: string[]) {
    super(
      `Could not detect a supported repository at ${root}.\n` +
        `Checked: ${attempts.join(", ")}.\n` +
        `DepRisk currently supports Node.js (package.json) and Python (pyproject.toml / requirements.txt) repositories.`,
    );
    this.name = "RepositoryNotSupportedError";
  }
}

export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(`${feature} is not implemented yet.`);
    this.name = "NotImplementedError";
  }
}
