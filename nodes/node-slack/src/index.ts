/**
 * @packageDocumentation
 * Slack integration node for CogniPipe workflows.
 *
 * This module exports the `SlackMessageNode` class, which posts messages through
 * Slack's `chat.postMessage` Web API method, along with its configuration and
 * output types.
 */

export { SlackMessageNode } from './SlackMessageNode.js';
export type {
  SlackMessageConfig,
  SlackMessageNodeOutput,
  SlackThreadReplyOutput,
} from './SlackMessageNode.js';
