const FORBIDDEN_IMPORTS = [
  "spawnPhase",
  "buildAncillaryChain",
  "ClaudeLanguageModel",
  "ApfelLanguageModel",
  "OllamaLanguageModel",
];
const FORBIDDEN_COMMANDS = ["claude", "pi"];

export default {
  name: "no-undeclared-agent-use",
  rules: {
    "no-undeclared-agent-use": {
      create(ctx: Deno.lint.RuleContext) {
        if (!ctx.filename.includes("src/tick-actions/")) return {};
        if (ctx.filename.endsWith("agent-access.ts")) return {};
        return {
          ImportDeclaration(node: Deno.lint.ImportDeclaration) {
            for (const spec of node.specifiers) {
              if (spec.type !== "ImportSpecifier") continue;
              if (FORBIDDEN_IMPORTS.includes(spec.imported.name)) {
                ctx.report({
                  node: spec,
                  message:
                    `${spec.imported.name} must be accessed through AgentAccess, not imported directly in tick-actions.`,
                });
              }
            }
          },
          NewExpression(node: Deno.lint.NewExpression) {
            if (
              node.callee.type === "MemberExpression" &&
              node.callee.object.type === "Identifier" &&
              node.callee.object.name === "Deno" &&
              node.callee.property.type === "Identifier" &&
              node.callee.property.name === "Command" &&
              node.arguments[0]?.type === "Literal" &&
              FORBIDDEN_COMMANDS.includes(node.arguments[0].value as string)
            ) {
              ctx.report({
                node: node.arguments[0],
                message:
                  `Direct Deno.Command("${node.arguments[0].value}") in tick-actions; use AgentAccess.spawn or AgentAccess.run instead.`,
              });
            }
          },
        };
      },
    },
  },
} satisfies Deno.lint.Plugin;
