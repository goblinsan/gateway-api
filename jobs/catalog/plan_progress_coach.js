import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

export const meta = {
    id: 'plan_progress_coach',
    name: 'Plan Progress Coach',
    description: 'Reviews a master plan against progress notes, sends scheduled coaching check-ins, and can append git-backed progress updates into a notes repo.',
};

const DEFAULT_AGENT_ID = 'bruvie-d';
const DEFAULT_NOTE_DIRS = ['daily', 'notes', 'inbox'];
const DEFAULT_RECENT_NOTES_LIMIT = 8;

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

function optionalString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalStringArray(value) {
    if (!Array.isArray(value)) {
        return null;
    }
    return value
        .filter((item) => typeof item === 'string' && item.trim())
        .map((item) => item.trim());
}

function normalizeInboxDelivery(value) {
    if (!value) {
        return null;
    }
    const inbox = requireRecord(value, 'workflow.input.inbox');
    const userId = requireString(inbox.userId, 'workflow.input.inbox.userId');
    return {
        mode: 'inbox',
        userId,
        channelId: optionalString(inbox.channelId) || 'coach',
        ...(optionalString(inbox.threadId) ? { threadId: optionalString(inbox.threadId) } : {}),
        ...(optionalString(inbox.threadTitle) ? { threadTitle: optionalString(inbox.threadTitle) } : {}),
        ...(optionalString(inbox.title) ? { title: optionalString(inbox.title) } : {}),
        ...(optionalString(inbox.kind) ? { kind: optionalString(inbox.kind) } : {}),
    };
}

function shellEscape(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function normalizePhase(value) {
    const phase = optionalString(value)?.toLowerCase();
    if (!phase) {
        return 'morning';
    }
    if (phase === 'morning' || phase === 'midday' || phase === 'evening') {
        return phase;
    }
    throw new Error(`workflow.input.phase must be one of morning, midday, evening`);
}

function localTimestamp(timeZone) {
    return new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).format(new Date());
}

function currentDateStamp(timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date());
    const record = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return `${record.year}-${record.month}-${record.day}`;
}

async function readText(filePath) {
    return readFile(filePath, 'utf8');
}

async function walkMarkdownFiles(rootPath, depth = 0) {
    if (depth > 3) {
        return [];
    }
    let entries = [];
    try {
        entries = await readdir(rootPath, { withFileTypes: true });
    } catch {
        return [];
    }

    const files = [];
    for (const entry of entries) {
        const entryPath = join(rootPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...await walkMarkdownFiles(entryPath, depth + 1));
            continue;
        }
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
            files.push(entryPath);
        }
    }
    return files;
}

async function loadRecentNotes(repoPath, searchDirs, limit) {
    const files = [];
    for (const dir of searchDirs) {
        files.push(...await walkMarkdownFiles(join(repoPath, dir)));
    }

    const uniqueFiles = [...new Set(files)];
    const withStats = await Promise.all(uniqueFiles.map(async (filePath) => {
        const fileStat = await stat(filePath);
        return {
            filePath,
            modifiedMs: fileStat.mtimeMs,
        };
    }));

    const selected = withStats
        .sort((left, right) => right.modifiedMs - left.modifiedMs)
        .slice(0, limit);

    return Promise.all(selected.map(async (item) => ({
        filePath: item.filePath,
        relativePath: relative(repoPath, item.filePath),
        content: await readText(item.filePath),
        modifiedMs: item.modifiedMs,
    })));
}

function buildDefaultDailyPath(repoPath, timeZone) {
    return join(repoPath, 'daily', `${currentDateStamp(timeZone)}.md`);
}

async function appendSection(filePath, sectionText) {
    await mkdir(dirname(filePath), { recursive: true });
    let prefix = '';
    try {
        const existing = await readFile(filePath, 'utf8');
        prefix = existing.endsWith('\n') ? '\n' : '\n\n';
    } catch {
        prefix = '';
    }
    await appendFile(filePath, `${prefix}${sectionText.trim()}\n`, 'utf8');
}

async function commitAndPushNotes(context, repoPath, changedPaths, commitMessage) {
    if (changedPaths.length === 0) {
        return null;
    }

    const addArgs = changedPaths.map((filePath) => shellEscape(relative(repoPath, filePath))).join(' ');
    const command = [
        `cd ${shellEscape(repoPath)}`,
        `git add -- ${addArgs}`,
        `if git diff --cached --quiet; then`,
        `  echo "No note changes to commit."`,
        `else`,
        `  git commit -m ${shellEscape(commitMessage)}`,
        `  git push`,
        `fi`,
    ].join('\n');

    context.log(`Committing note updates in ${repoPath}`);
    return context.runShell(`sh -lc ${shellEscape(command)}`);
}

function phaseInstructions(phase) {
    if (phase === 'midday') {
        return [
            'This is the midday accountability checkpoint.',
            'Assess whether the current day is tracking against the 2-week plan.',
            'Call out drift directly, then give the smallest realistic correction for the second half of the day.',
            'Keep it concise and specific.',
        ].join('\n');
    }
    if (phase === 'evening') {
        return [
            'This is the evening review and reset.',
            'Compare completed work against the plan and recent notes.',
            'Acknowledge wins, name the gap honestly, and finish with the most important setup for tomorrow.',
            'Keep it constructive, not sentimental.',
        ].join('\n');
    }
    return [
        'This is the morning kickoff.',
        'Use the plan and recent notes to identify the most important work for today.',
        'Start with a brief motivating opener, then give 3 concrete goals and one avoid-this warning.',
        'Bias toward clarity, urgency, and momentum.',
    ].join('\n');
}

function buildCoachPrompt({ planText, recentNotes, phase, timeZone, nowLabel }) {
    const notesBlock = recentNotes.length > 0
        ? recentNotes.map((note) => [`File: ${note.relativePath}`, note.content.trim()].join('\n')).join('\n\n---\n\n')
        : '(No recent notes found.)';

    return [
        `You are a direct personal project coach helping the user execute a 2-week plan.`,
        `Local time: ${nowLabel} (${timeZone})`,
        `Check-in phase: ${phase}`,
        '',
        phaseInstructions(phase),
        '',
        'Master plan:',
        planText.trim(),
        '',
        'Recent progress notes:',
        notesBlock,
        '',
        'Output requirements:',
        '- 1 short motivating opener',
        '- 3 concrete priorities or questions tied to the plan',
        '- mention the specific deliverable or decision that matters most next',
        '- no markdown tables',
        '- keep it under 220 words',
    ].join('\n');
}

function buildReflectionPrompt({ planText, recentNotes, progressEntry, timeZone, nowLabel }) {
    const notesBlock = recentNotes.length > 0
        ? recentNotes.map((note) => [`File: ${note.relativePath}`, note.content.trim()].join('\n')).join('\n\n---\n\n')
        : '(No recent notes found.)';

    return [
        'You are a direct personal project coach.',
        `Local time: ${nowLabel} (${timeZone})`,
        'The user just recorded a progress update.',
        'Compare it against the 2-week plan and recent notes.',
        'Reply with a short acknowledgement, the main progress signal, and the next best step.',
        'Keep it under 140 words.',
        '',
        'Master plan:',
        planText.trim(),
        '',
        'Recent progress notes:',
        notesBlock,
        '',
        'New progress update:',
        progressEntry.trim(),
    ].join('\n');
}

export async function run(context) {
    const input = requireRecord(context.input, 'workflow.input');
    const mode = optionalString(input.mode)?.toLowerCase() || 'check-in';
    const planFilePath = requireString(input.planFilePath, 'workflow.input.planFilePath');
    const notesRepoPath = requireString(input.notesRepoPath, 'workflow.input.notesRepoPath');
    const timeZone = optionalString(input.timeZone) || 'America/New_York';
    const agentId = optionalString(input.agentId) || DEFAULT_AGENT_ID;
    const noteLog = input.noteLog ? requireRecord(input.noteLog, 'workflow.input.noteLog') : {};
    const delivery = input.delivery ? requireRecord(input.delivery, 'workflow.input.delivery') : null;
    const inboxDelivery = normalizeInboxDelivery(input.inbox);
    const chatThread = input.chatThread ? requireRecord(input.chatThread, 'workflow.input.chatThread') : null;
    const searchDirs = optionalStringArray(input.notesSearchDirs) || DEFAULT_NOTE_DIRS;
    const recentNotesLimit = typeof input.recentNotesLimit === 'number' && Number.isFinite(input.recentNotesLimit)
        ? Math.max(1, Math.floor(input.recentNotesLimit))
        : DEFAULT_RECENT_NOTES_LIMIT;

    const planText = await readText(planFilePath);
    const recentNotes = await loadRecentNotes(notesRepoPath, searchDirs, recentNotesLimit);
    const nowLabel = localTimestamp(timeZone);
    const changedPaths = [];
    const agentContext = chatThread && typeof chatThread.threadId === 'string' && chatThread.threadId.trim()
        ? {
            source: mode === 'check-in' ? 'ancr-coach-check-in' : 'ancr-coach-progress',
            metadata: {
                threadId: chatThread.threadId.trim(),
                ...(typeof chatThread.threadTitle === 'string' && chatThread.threadTitle.trim()
                    ? { threadTitle: chatThread.threadTitle.trim() }
                    : {}),
            },
        }
        : undefined;

    if (mode === 'log-progress') {
        const progressEntry = requireString(input.progressEntry, 'workflow.input.progressEntry');
        const progressSource = optionalString(input.progressSource) || 'manual';
        const notePath = optionalString(noteLog.relativePath)
            ? resolve(notesRepoPath, noteLog.relativePath)
            : buildDefaultDailyPath(notesRepoPath, timeZone);
        const noteSection = [
            `## Progress Update (${nowLabel})`,
            '',
            `Source: ${progressSource}`,
            '',
            progressEntry,
        ].join('\n');

        await appendSection(notePath, noteSection);
        changedPaths.push(notePath);

        let reflection = null;
        if (delivery || inboxDelivery || input.includeReflection === true) {
            context.log(`Calling local coach agent for reflection: ${agentId}`);
            reflection = await context.runAgent(agentId, buildReflectionPrompt({
                planText,
                recentNotes,
                progressEntry,
                timeZone,
                nowLabel,
            }), inboxDelivery, agentContext);
            await appendSection(notePath, [
                `## Coach Reflection (${nowLabel})`,
                '',
                reflection.content,
            ].join('\n'));
        }

        let deliveryResult = null;
        if (delivery && typeof delivery.channel === 'string' && delivery.channel.trim() && reflection?.content) {
            deliveryResult = await context.deliver(delivery.channel.trim(), reflection.content, {
                workflowId: context.workflow.id,
                jobId: meta.id,
                mode,
            });
        }

        const gitResult = noteLog.commit === false
            ? null
            : await commitAndPushNotes(
                context,
                notesRepoPath,
                changedPaths,
                `coach: log progress ${currentDateStamp(timeZone)}`
            );

        return {
            mode,
            notePath: relative(notesRepoPath, notePath),
            recentNotes: recentNotes.map((note) => note.relativePath),
            reflection,
            inbox: reflection?.inbox ?? null,
            delivery: deliveryResult,
            git: gitResult,
        };
    }

    if (mode !== 'check-in') {
        throw new Error(`Unsupported workflow.input.mode: ${mode}`);
    }

    const phase = normalizePhase(input.phase ?? input.checkInPhase);
    context.log(`Calling local coach agent for ${phase} check-in: ${agentId}`);
    const coachResult = await context.runAgent(agentId, buildCoachPrompt({
        planText,
        recentNotes,
        phase,
        timeZone,
        nowLabel,
    }), inboxDelivery, agentContext);

    let deliveryResult = null;
    if (delivery && typeof delivery.channel === 'string' && delivery.channel.trim()) {
        context.log(`Delivering coaching prompt to channel: ${delivery.channel}`);
        deliveryResult = await context.deliver(delivery.channel.trim(), coachResult.content, {
            workflowId: context.workflow.id,
            jobId: meta.id,
            mode,
            phase,
        });
    }

    const notePath = noteLog.enabled === false
        ? null
        : optionalString(noteLog.relativePath)
            ? resolve(notesRepoPath, noteLog.relativePath)
            : buildDefaultDailyPath(notesRepoPath, timeZone);

    if (notePath) {
        await appendSection(notePath, [
            `## Coach ${phase[0].toUpperCase()}${phase.slice(1)} Check-In (${nowLabel})`,
            '',
            coachResult.content,
        ].join('\n'));
        changedPaths.push(notePath);
    }

    const gitResult = notePath && noteLog.commit !== false
        ? await commitAndPushNotes(
            context,
            notesRepoPath,
            changedPaths,
            `coach: ${phase} check-in ${currentDateStamp(timeZone)}`
        )
        : null;

    return {
        mode,
        phase,
        planFilePath,
        notesRepoPath,
        recentNotes: recentNotes.map((note) => note.relativePath),
        coach: coachResult,
        inbox: coachResult.inbox ?? null,
        delivery: deliveryResult,
        notePath: notePath ? relative(notesRepoPath, notePath) : null,
        git: gitResult,
    };
}
