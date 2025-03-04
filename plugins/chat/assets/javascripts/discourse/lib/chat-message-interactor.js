import getURL from "discourse-common/lib/get-url";
import { bind } from "discourse-common/utils/decorators";
import showModal from "discourse/lib/show-modal";
import ChatMessageFlag from "discourse/plugins/chat/discourse/lib/chat-message-flag";
import Bookmark from "discourse/models/bookmark";
import { openBookmarkModal } from "discourse/controllers/bookmark";
import { popupAjaxError } from "discourse/lib/ajax-error";
import { action } from "@ember/object";
import { inject as service } from "@ember/service";
import { isTesting } from "discourse-common/config/environment";
import { clipboardCopy } from "discourse/lib/utilities";
import ChatMessageReaction, {
  REACTIONS,
} from "discourse/plugins/chat/discourse/models/chat-message-reaction";
import { getOwner, setOwner } from "@ember/application";
import { tracked } from "@glimmer/tracking";
import ChatMessage from "discourse/plugins/chat/discourse/models/chat-message";
import { MESSAGE_CONTEXT_THREAD } from "discourse/plugins/chat/discourse/components/chat-message";
import I18n from "I18n";

export default class ChatMessageInteractor {
  @service appEvents;
  @service dialog;
  @service chat;
  @service chatEmojiReactionStore;
  @service chatEmojiPickerManager;
  @service chatChannelComposer;
  @service chatThreadComposer;
  @service chatChannelPane;
  @service chatThreadPane;
  @service chatApi;
  @service currentUser;
  @service site;
  @service router;

  @tracked message = null;
  @tracked context = null;

  cachedFavoritesReactions = null;

  constructor(owner, message, context) {
    setOwner(this, owner);

    this.message = message;
    this.context = context;
    this.cachedFavoritesReactions = this.chatEmojiReactionStore.favorites;
  }

  get capabilities() {
    return getOwner(this).lookup("capabilities:main");
  }

  get pane() {
    return this.context === MESSAGE_CONTEXT_THREAD
      ? this.chatThreadPane
      : this.chatChannelPane;
  }

  get emojiReactions() {
    let favorites = this.cachedFavoritesReactions;

    // may be a {} if no defaults defined in some production builds
    if (!favorites || !favorites.slice) {
      return [];
    }

    return favorites.slice(0, 3).map((emoji) => {
      return (
        this.message.reactions.find((reaction) => reaction.emoji === emoji) ||
        ChatMessageReaction.create({ emoji })
      );
    });
  }

  get canEdit() {
    return (
      !this.message.deletedAt &&
      this.currentUser.id === this.message.user.id &&
      this.message.channel?.canModifyMessages?.(this.currentUser)
    );
  }

  get canInteractWithMessage() {
    return (
      !this.message?.deletedAt &&
      this.message?.channel?.canModifyMessages(this.currentUser)
    );
  }

  get canRestoreMessage() {
    return (
      this.canDelete &&
      this.message?.deletedAt &&
      this.message.channel?.canModifyMessages?.(this.currentUser)
    );
  }

  get canBookmark() {
    return this.message?.channel?.canModifyMessages?.(this.currentUser);
  }

  get canReply() {
    return (
      this.canInteractWithMessage && this.context !== MESSAGE_CONTEXT_THREAD
    );
  }

  get canReact() {
    return this.canInteractWithMessage;
  }

  get canFlagMessage() {
    return (
      this.currentUser?.id !== this.message?.user?.id &&
      !this.message.channel?.isDirectMessageChannel &&
      this.message?.userFlagStatus === undefined &&
      this.message.channel?.canFlag &&
      !this.message?.chatWebhookEvent &&
      !this.message?.deletedAt
    );
  }

  get canRebakeMessage() {
    return (
      this.currentUser?.staff &&
      this.message.channel?.canModifyMessages?.(this.currentUser)
    );
  }

  get canDeleteMessage() {
    return (
      this.canDelete &&
      !this.message?.deletedAt &&
      this.message.channel?.canModifyMessages?.(this.currentUser)
    );
  }

  get canDelete() {
    return this.currentUser?.id === this.message.user.id
      ? this.message.channel?.canDeleteSelf
      : this.message.channel?.canDeleteOthers;
  }

  get composer() {
    return this.context === MESSAGE_CONTEXT_THREAD
      ? this.chatThreadComposer
      : this.chatChannelComposer;
  }

  get secondaryButtons() {
    const buttons = [];

    buttons.push({
      id: "copyLink",
      name: I18n.t("chat.copy_link"),
      icon: "link",
    });

    if (this.canEdit) {
      buttons.push({
        id: "edit",
        name: I18n.t("chat.edit"),
        icon: "pencil-alt",
      });
    }

    if (!this.pane.selectingMessages) {
      buttons.push({
        id: "select",
        name: I18n.t("chat.select"),
        icon: "tasks",
      });
    }

    if (this.canFlagMessage) {
      buttons.push({
        id: "flag",
        name: I18n.t("chat.flag"),
        icon: "flag",
      });
    }

    if (this.canDeleteMessage) {
      buttons.push({
        id: "delete",
        name: I18n.t("chat.delete"),
        icon: "trash-alt",
      });
    }

    if (this.canRestoreMessage) {
      buttons.push({
        id: "restore",
        name: I18n.t("chat.restore"),
        icon: "undo",
      });
    }

    if (this.canRebakeMessage) {
      buttons.push({
        id: "rebake",
        name: I18n.t("chat.rebake_message"),
        icon: "sync-alt",
      });
    }

    return buttons;
  }

  select(checked = true) {
    this.message.selected = checked;
    this.pane.onSelectMessage(this.message);
  }

  bulkSelect(checked) {
    const manager = this.message.manager;
    const lastSelectedIndex = manager.findIndexOfMessage(
      this.pane.lastSelectedMessage.id
    );
    const newlySelectedIndex = manager.findIndexOfMessage(this.message.id);
    const sortedIndices = [lastSelectedIndex, newlySelectedIndex].sort(
      (a, b) => a - b
    );

    for (let i = sortedIndices[0]; i <= sortedIndices[1]; i++) {
      manager.messages[i].selected = checked;
    }
  }

  copyLink() {
    const { protocol, host } = window.location;
    const channelId = this.message.channel.id;
    const threadId = this.message.thread?.id;

    let url;
    if (this.context === MESSAGE_CONTEXT_THREAD && threadId) {
      url = getURL(`/chat/c/-/${channelId}/t/${threadId}`);
    } else {
      url = getURL(`/chat/c/-/${channelId}/${this.message.id}`);
    }

    url = url.indexOf("/") === 0 ? protocol + "//" + host + url : url;
    clipboardCopy(url);
  }

  @action
  react(emoji, reactAction) {
    if (!this.chat.userCanInteractWithChat) {
      return;
    }

    if (this.pane.reacting) {
      return;
    }

    if (this.capabilities.canVibrate && !isTesting()) {
      navigator.vibrate(5);
    }

    if (this.site.mobileView) {
      this.chat.activeMessage = null;
    }

    if (reactAction === REACTIONS.add) {
      this.chatEmojiReactionStore.track(`:${emoji}:`);
    }

    this.pane.reacting = true;

    this.message.react(
      emoji,
      reactAction,
      this.currentUser,
      this.currentUser.id
    );

    return this.chatApi
      .publishReaction(
        this.message.channel.id,
        this.message.id,
        emoji,
        reactAction
      )
      .catch((errResult) => {
        popupAjaxError(errResult);
        this.message.react(
          emoji,
          REACTIONS.remove,
          this.currentUser,
          this.currentUser.id
        );
      })
      .finally(() => {
        this.pane.reacting = false;
      });
  }

  @action
  toggleBookmark() {
    return openBookmarkModal(
      this.message.bookmark ||
        Bookmark.createFor(this.currentUser, "Chat::Message", this.message.id),
      {
        onAfterSave: (savedData) => {
          const bookmark = Bookmark.create(savedData);
          this.message.bookmark = bookmark;
          this.appEvents.trigger(
            "bookmarks:changed",
            savedData,
            bookmark.attachedTo()
          );
        },
        onAfterDelete: () => {
          this.message.bookmark = null;
        },
      }
    );
  }

  @action
  flag() {
    const model = new ChatMessage(this.message.channel, this.message);
    model.username = this.message.user?.username;
    model.user_id = this.message.user?.id;
    const controller = showModal("flag", { model });
    controller.set("flagTarget", new ChatMessageFlag());
  }

  @action
  delete() {
    return this.chatApi
      .trashMessage(this.message.channel.id, this.message.id)
      .catch(popupAjaxError);
  }

  @action
  restore() {
    return this.chatApi
      .restoreMessage(this.message.channel.id, this.message.id)
      .catch(popupAjaxError);
  }

  @action
  rebake() {
    return this.chatApi
      .rebakeMessage(this.message.channel.id, this.message.id)
      .catch(popupAjaxError);
  }

  @action
  reply() {
    this.composer.replyTo(this.message);
  }

  @action
  edit() {
    this.composer.edit(this.message);
  }

  @action
  openEmojiPicker(_, { target }) {
    const pickerState = {
      didSelectEmoji: this.selectReaction,
      trigger: target,
      context: "chat-channel-message",
    };
    this.chatEmojiPickerManager.open(pickerState);
  }

  @bind
  selectReaction(emoji) {
    if (!this.chat.userCanInteractWithChat) {
      return;
    }

    this.react(emoji, REACTIONS.add);
  }

  @action
  handleSecondaryButtons(id) {
    this[id](this.message);
  }
}
