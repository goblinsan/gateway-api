export const meta = {
    id: 'reason_script_summarize_deliver',
    name: 'Reason, Script, Summarize, Deliver',
    description: 'Runs an OpenAI reasoning step, optional local shell command, local-agent summarization, and optional delivery to a configured channel.',
};

function requireRecord(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${field} must be an object`);
    }
    return value;
}

function requireString(value, field) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${field} must be a non-empty string`);
    }
    return value.trim();
}

export async function run(context) {
    const input = requireRecord(context.input, 'workflow.input');
    const reasoning = requireRecord(input.reasoning, 'workflow.input.reasoning');
    const summary = requireRecord(input.summary, 'workflow.input.summary');
    const delivery = input.delivery ? requireRecord(input.delivery, 'workflow.input.delivery') : null;
    const script = input.script ? requireRecord(input.script, 'workflow.input.script') : null;

    const reasoningPrompt = requireString(reasoning.prompt, 'workflow.input.reasoning.prompt');
    const summaryAgentId = requireString(summary.agentId, 'workflow.input.summary.agentId');
    const summaryInstructions = typeof summary.instructions === 'string' && summary.instructions.trim()
        ? summary.instructions.trim()
        : 'Summarize this into a concise, actionable update for the configured delivery channel.';

    context.log('Calling OpenAI reasoning step');
    const reasoningText = await context.callOpenAi({
        model: typeof reasoning.model === 'string' ? reasoning.model : undefined,
        system: typeof reasoning.system === 'string' ? reasoning.system : undefined,
        prompt: reasoningPrompt,
    });

    let scriptResult = null;
    if (script && typeof script.command === 'string' && script.command.trim()) {
        context.log(`Running local shell command: ${script.command}`);
        scriptResult = await context.runShell(
            script.command,
            typeof script.cwd === 'string' && script.cwd.trim() ? script.cwd : undefined
        );
    }

    const summaryPrompt = [
        summaryInstructions,
        '',
        'Reasoning output:',
        reasoningText,
        '',
        scriptResult
            ? [
                'Shell command:',
                scriptResult.command,
                '',
                'Shell stdout:',
                scriptResult.stdout || '(empty)',
                '',
                'Shell stderr:',
                scriptResult.stderr || '(empty)',
            ].join('\n')
            : 'Shell step: not used',
    ].join('\n');

    context.log(`Calling local summarizer agent: ${summaryAgentId}`);
    const summaryResult = await context.runAgent(summaryAgentId, summaryPrompt);

    let deliveryResult = null;
    if (delivery && typeof delivery.channel === 'string' && delivery.channel.trim()) {
        context.log(`Delivering summary to channel: ${delivery.channel}`);
        deliveryResult = await context.deliver(delivery.channel.trim(), summaryResult.content, {
            workflowId: context.workflow.id,
            jobId: meta.id,
            summaryAgentId,
        });
    }

    return {
        reasoning: {
            model: typeof reasoning.model === 'string' ? reasoning.model : null,
            content: reasoningText,
        },
        script: scriptResult,
        summary: summaryResult,
        delivery: deliveryResult,
    };
}
