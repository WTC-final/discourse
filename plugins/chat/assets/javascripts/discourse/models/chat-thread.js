import { getOwner } from "discourse-common/lib/get-owner";
import I18n from "I18n";
import ChatMessagesManager from "discourse/plugins/chat/discourse/lib/chat-messages-manager";
import { escapeExpression } from "discourse/lib/utilities";
import { tracked } from "@glimmer/tracking";
import guid from "pretty-text/guid";
import ChatMessage from "discourse/plugins/chat/discourse/models/chat-message";
import ChatTrackingState from "discourse/plugins/chat/discourse/models/chat-tracking-state";
import UserChatThreadMembership from "discourse/plugins/chat/discourse/models/user-chat-thread-membership";
import ChatThreadPreview from "discourse/plugins/chat/discourse/models/chat-thread-preview";

export const THREAD_STATUSES = {
  open: "open",
  readOnly: "read_only",
  closed: "closed",
  archived: "archived",
};

export default class ChatThread {
  static create(channel, args = {}) {
    return new ChatThread(channel, args);
  }

  @tracked id;
  @tracked title;
  @tracked status;
  @tracked draft;
  @tracked staged;
  @tracked channel;
  @tracked originalMessage;
  @tracked threadMessageBusLastId;
  @tracked replyCount;
  @tracked tracking;
  @tracked currentUserMembership = null;
  @tracked preview = null;

  messagesManager = new ChatMessagesManager(getOwner(this));

  constructor(channel, args = {}) {
    this.id = args.id;
    this.channel = channel;
    this.status = args.status;
    this.draft = args.draft;
    this.staged = args.staged;
    this.replyCount = args.reply_count;
    this.originalMessage = ChatMessage.create(channel, args.original_message);

    this.title =
      args.title ||
      `${I18n.t("chat.thread.default_title", {
        thread_id: this.id,
      })}`;

    if (args.current_user_membership) {
      this.currentUserMembership = UserChatThreadMembership.create(
        args.current_user_membership
      );
    }

    this.tracking = new ChatTrackingState(getOwner(this));
    if (args.preview) {
      this.preview = ChatThreadPreview.create(args.preview);
    }
  }

  async stageMessage(message) {
    message.id = guid();
    message.staged = true;
    message.draft = false;
    message.createdAt ??= moment.utc().format();
    message.thread = this;
    await message.cook();

    this.messagesManager.addMessages([message]);
  }

  get lastMessage() {
    return this.messagesManager.findLastMessage();
  }

  lastUserMessage(user) {
    return this.messagesManager.findLastUserMessage(user);
  }

  get routeModels() {
    return [...this.channel.routeModels, this.id];
  }

  get messages() {
    return this.messagesManager.messages;
  }

  set messages(messages) {
    this.messagesManager.messages = messages;
  }

  get selectedMessages() {
    return this.messages.filter((message) => message.selected);
  }

  get escapedTitle() {
    return escapeExpression(this.title);
  }
}
