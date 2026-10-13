/**
 * The discussion commands promise "an issue opens on the next push" only when
 * the vault has the workflow that does it. A vault with just the plugin (BRAT
 * install, no `Setup research automation`) must be told what is missing.
 */
import { describe, it, expect } from 'vitest';
import type { LabnoteHost } from '@labnoteo/core';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { isIssueAutomationInstalled, issueAutomationState } from '../../src/commands';
import { ISSUE_SYNC_WORKFLOW_PATH } from '../../src/scaffold/assets';

const hostWith = (files: Record<string, string>) =>
  ({ fs: new MemFileSystem(files) }) as unknown as LabnoteHost;

describe('isIssueAutomationInstalled', () => {
  it('is true once the issue workflow has been scaffolded', async () => {
    expect(ISSUE_SYNC_WORKFLOW_PATH).toBe('.github/workflows/experiment-issues.yml');
    expect(await isIssueAutomationInstalled(hostWith({ [ISSUE_SYNC_WORKFLOW_PATH]: 'on: push' }))).toBe(true);
  });

  it('is false for a plugin-only vault', async () => {
    const host = hostWith({ 'labnote/001_Test/README.labnote.md': '---\ndiscuss: true\n---\n' });
    expect(await isIssueAutomationInstalled(host)).toBe(false);
  });
});

// #45: an installed automation in a vault that is not a git repository was
// still told "An issue opens on the next push".
describe('issueAutomationState', () => {
  it("is 'none' without the issue workflow", async () => {
    expect(await issueAutomationState(hostWith({ '.git/HEAD': 'ref: refs/heads/main' }))).toBe('none');
  });

  it("is 'no-git' when the workflow is installed but the vault is not a repository", async () => {
    expect(await issueAutomationState(hostWith({ [ISSUE_SYNC_WORKFLOW_PATH]: 'on: push' }))).toBe('no-git');
  });

  it("is 'ready' when both are present", async () => {
    const host = hostWith({ [ISSUE_SYNC_WORKFLOW_PATH]: 'on: push', '.git/HEAD': 'ref: refs/heads/main' });
    expect(await issueAutomationState(host)).toBe('ready');
  });

  it("treats a `.git` file (worktree) as a repository", async () => {
    const host = hostWith({ [ISSUE_SYNC_WORKFLOW_PATH]: 'on: push', '.git': 'gitdir: ../main/.git' });
    expect(await issueAutomationState(host)).toBe('ready');
  });
});
