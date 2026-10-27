export function evaluationPrompt(task: string): string {
  return `Implement the following task in the current repository.
Work only in this working directory. Do not read parent directories, credentials, evaluation assets, or other runs.
Do not change the supplied public tests or package manifest; you may add your own tests.
Do not install dependencies, make network requests from tools, use sudo, commit, push, or publish.
Use the available coding tools and run the relevant local tests. Leave the implementation as a working-tree diff.
Report actual changes and test outcomes, and explicitly identify anything unverified.

<task>
${task.trim()}
</task>`;
}
