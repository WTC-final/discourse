import Composer, { SAVE_ICONS, SAVE_LABELS } from "discourse/models/composer";
import Controller from "@ember/controller";
import EmberObject, { action, computed } from "@ember/object";
import { alias, and, or, reads } from "@ember/object/computed";
import {
  authorizesOneOrMoreExtensions,
  uploadIcon,
} from "discourse/lib/uploads";
import { cancel, scheduleOnce } from "@ember/runloop";
import {
  cannotPostAgain,
  durationTextFromSeconds,
} from "discourse/helpers/slow-mode";
import discourseComputed from "discourse-common/utils/decorators";
import { observes, on } from "@ember-decorators/object";
import DiscourseURL from "discourse/lib/url";
import Draft from "discourse/models/draft";
import I18n from "I18n";
import { Promise } from "rsvp";
import { buildQuote } from "discourse/lib/quote";
import deprecated from "discourse-common/lib/deprecated";
import discourseDebounce from "discourse-common/lib/debounce";
import { emojiUnescape } from "discourse/lib/text";
import { escapeExpression, modKeysPressed } from "discourse/lib/utilities";
import { getOwner } from "discourse-common/lib/get-owner";
import getURL from "discourse-common/lib/get-url";
import { isEmpty } from "@ember/utils";
import { isTesting } from "discourse-common/config/environment";
import { inject as service } from "@ember/service";
import { shortDate } from "discourse/lib/formatter";
import showModal from "discourse/lib/show-modal";
import { categoryBadgeHTML } from "discourse/helpers/category-link";
import renderTags from "discourse/lib/render-tags";
import { htmlSafe } from "@ember/template";
import { iconHTML } from "discourse-common/lib/icon-library";

async function loadDraft(store, opts = {}) {
  let { draft, draftKey, draftSequence } = opts;

  try {
    if (draft && typeof draft === "string") {
      draft = JSON.parse(draft);
    }
  } catch (error) {
    draft = null;
    Draft.clear(draftKey, draftSequence);
  }

  if (!draft?.title && !draft?.reply) {
    return;
  }

  let attrs = {
    draftKey,
    draftSequence,
    draft: true,
    composerState: Composer.DRAFT,
    topic: opts.topic,
  };

  Composer.serializedFieldsForDraft().forEach((f) => {
    attrs[f] = draft[f] || opts[f];
  });

  const composer = store.createRecord("composer");
  await composer.open(attrs);

  return composer;
}

const _popupMenuOptionsCallbacks = [];
const _composerSaveErrorCallbacks = [];

let _checkDraftPopup = !isTesting();

export function toggleCheckDraftPopup(enabled) {
  _checkDraftPopup = enabled;
}

export function clearPopupMenuOptionsCallback() {
  _popupMenuOptionsCallbacks.length = 0;
}

export function addPopupMenuOptionsCallback(callback) {
  _popupMenuOptionsCallbacks.push(callback);
}

export function clearComposerSaveErrorCallback() {
  _composerSaveErrorCallbacks.length = 0;
}

export function addComposerSaveErrorCallback(callback) {
  _composerSaveErrorCallbacks.push(callback);
}

export default class ComposerController extends Controller {
  @service router;
  @service dialog;
  @service site;
  @service store;
  @service appEvents;

  checkedMessages = false;
  messageCount = null;
  showEditReason = false;
  editReason = null;
  scopedCategoryId = null;
  prioritizedCategoryId = null;
  lastValidatedAt = null;
  isUploading = false;
  isProcessingUpload = false;
  topic = null;
  linkLookup = null;
  showPreview = true;
  composerHeight = null;

  @and("site.mobileView", "showPreview") forcePreview;
  @or("isWhispering", "model.unlistTopic") whisperOrUnlistTopic;
  @alias("site.categoriesList") categories;
  @alias("topicController.model") topicModel;
  @reads("currentUser.staff") isStaffUser;
  @reads("currentUser.whisperer") whisperer;
  @and("model.creatingTopic", "isStaffUser") canUnlistTopic;
  @or("replyingToWhisper", "model.whisper") isWhispering;

  get topicController() {
    return getOwner(this).lookup("controller:topic");
  }

  get capabilities() {
    return getOwner(this).lookup("capabilities:main");
  }

  @on("init")
  _setupPreview() {
    const val = this.site.mobileView
      ? false
      : this.keyValueStore.get("composer.showPreview") || "true";
    this.set("showPreview", val === "true");
  }

  @computed(
    "model.loading",
    "isUploading",
    "isProcessingUpload",
    "_disableSubmit"
  )
  get disableSubmit() {
    return (
      this.model?.loading ||
      this.isUploading ||
      this.isProcessingUpload ||
      this._disableSubmit
    );
  }

  set disableSubmit(value) {
    return this.set("_disableSubmit", value);
  }

  get formTemplateIds() {
    if (!this.siteSettings.experimental_form_templates) {
      return null;
    }

    return this.model.category?.get("form_template_ids");
  }

  @discourseComputed("showPreview")
  toggleText(showPreview) {
    return showPreview
      ? I18n.t("composer.hide_preview")
      : I18n.t("composer.show_preview");
  }

  @observes("showPreview")
  showPreviewChanged() {
    if (!this.site.mobileView) {
      this.keyValueStore.set({
        key: "composer.showPreview",
        value: this.showPreview,
      });
    }
  }

  @discourseComputed(
    "model.replyingToTopic",
    "model.creatingPrivateMessage",
    "model.targetRecipients",
    "model.composeState"
  )
  focusTarget(replyingToTopic, creatingPM, usernames, composeState) {
    // Focus on usernames if it's blank or if it's just you
    usernames = usernames || "";
    if (
      (creatingPM && usernames.length === 0) ||
      usernames === this.currentUser.username
    ) {
      return "usernames";
    }

    if (replyingToTopic) {
      return "reply";
    }

    if (composeState === Composer.FULLSCREEN) {
      return "editor";
    }

    return "title";
  }

  @computed
  get showToolbar() {
    const keyValueStore = getOwner(this).lookup("service:key-value-store");
    const storedVal = keyValueStore.get("toolbar-enabled");
    if (this._toolbarEnabled === undefined && storedVal === undefined) {
      // iPhone 6 is 375, anything narrower and toolbar should
      // be default disabled.
      // That said we should remember the state
      this._toolbarEnabled =
        window.innerWidth > 370 && !this.capabilities.isAndroid;
    }
    return this._toolbarEnabled || storedVal === "true";
  }

  set showToolbar(val) {
    const keyValueStore = getOwner(this).lookup("service:key-value-store");
    this._toolbarEnabled = val;
    keyValueStore.set({
      key: "toolbar-enabled",
      value: val ? "true" : "false",
    });
    return val;
  }

  @discourseComputed("model.canEditTitle", "model.creatingPrivateMessage")
  canEditTags(canEditTitle, creatingPrivateMessage) {
    if (creatingPrivateMessage && this.site.mobileView) {
      return false;
    }

    const isPrivateMessage =
      creatingPrivateMessage || this.get("model.topic.isPrivateMessage");

    return (
      canEditTitle &&
      this.site.can_tag_topics &&
      (!isPrivateMessage || this.site.can_tag_pms)
    );
  }

  @discourseComputed("model.editingPost", "model.topic.details.can_edit")
  disableCategoryChooser(editingPost, canEditTopic) {
    return editingPost && !canEditTopic;
  }

  @discourseComputed("model.editingPost", "model.topic.canEditTags")
  disableTagsChooser(editingPost, canEditTags) {
    return editingPost && !canEditTags;
  }

  @discourseComputed("canWhisper", "replyingToWhisper")
  showWhisperToggle(canWhisper, replyingToWhisper) {
    return canWhisper && !replyingToWhisper;
  }

  @discourseComputed("model.post")
  replyingToWhisper(repliedToPost) {
    return (
      repliedToPost && repliedToPost.post_type === this.site.post_types.whisper
    );
  }

  @discourseComputed("model.action", "isWhispering", "model.privateMessage")
  saveIcon(modelAction, isWhispering, privateMessage) {
    if (isWhispering) {
      return "far-eye-slash";
    }
    if (privateMessage && modelAction === Composer.REPLY) {
      return "envelope";
    }

    return SAVE_ICONS[modelAction];
  }

  // Note we update when some other attributes like tag/category change to allow
  // text customizations to use those.
  @discourseComputed(
    "model.action",
    "isWhispering",
    "model.editConflict",
    "model.privateMessage",
    "model.tags",
    "model.category"
  )
  saveLabel(modelAction, isWhispering, editConflict, privateMessage) {
    let result = this.model.customizationFor("saveLabel");
    if (result) {
      return result;
    }

    if (editConflict) {
      return "composer.overwrite_edit";
    } else if (isWhispering) {
      return "composer.create_whisper";
    } else if (privateMessage && modelAction === Composer.REPLY) {
      return "composer.create_pm";
    }

    return SAVE_LABELS[modelAction];
  }

  @discourseComputed("whisperer", "model.action")
  canWhisper(whisperer, modelAction) {
    return whisperer && modelAction === Composer.REPLY;
  }

  _setupPopupMenuOption(callback) {
    let option = callback(this);
    if (typeof option === "undefined") {
      return null;
    }

    if (typeof option.condition === "undefined") {
      option.condition = true;
    } else if (typeof option.condition === "boolean") {
      // uses existing value
    } else {
      option.condition = this.get(option.condition);
    }

    return option;
  }

  @discourseComputed("model.requiredCategoryMissing", "model.replyLength")
  disableTextarea(requiredCategoryMissing, replyLength) {
    return requiredCategoryMissing && replyLength === 0;
  }

  @discourseComputed("model.composeState", "model.creatingTopic", "model.post")
  popupMenuOptions(composeState) {
    if (composeState === "open" || composeState === "fullscreen") {
      const options = [];

      options.push(
        this._setupPopupMenuOption(() => {
          return {
            action: "toggleInvisible",
            icon: "far-eye-slash",
            label: "composer.toggle_unlisted",
            condition: "canUnlistTopic",
          };
        })
      );

      if (this.capabilities.touch) {
        options.push(
          this._setupPopupMenuOption(() => {
            return {
              action: "applyFormatCode",
              icon: "code",
              label: "composer.code_title",
            };
          })
        );

        options.push(
          this._setupPopupMenuOption(() => {
            return {
              action: "applyUnorderedList",
              icon: "list-ul",
              label: "composer.ulist_title",
            };
          })
        );

        options.push(
          this._setupPopupMenuOption(() => {
            return {
              action: "applyOrderedList",
              icon: "list-ol",
              label: "composer.olist_title",
            };
          })
        );
      }

      options.push(
        this._setupPopupMenuOption(() => {
          return {
            action: "toggleWhisper",
            icon: "far-eye-slash",
            label: "composer.toggle_whisper",
            condition: "showWhisperToggle",
          };
        })
      );

      return options.concat(
        _popupMenuOptionsCallbacks
          .map((callback) => this._setupPopupMenuOption(callback))
          .filter((o) => o)
      );
    }
  }

  @discourseComputed(
    "model.creatingPrivateMessage",
    "model.targetRecipients",
    "model.warningsDisabled"
  )
  showWarning(creatingPrivateMessage, usernames, warningsDisabled) {
    if (!this.get("currentUser.staff") || warningsDisabled) {
      return false;
    }

    const hasTargetGroups = this.get("model.hasTargetGroups");

    // We need exactly one user to issue a warning
    if (
      isEmpty(usernames) ||
      usernames.split(",").length !== 1 ||
      hasTargetGroups
    ) {
      return false;
    }

    return creatingPrivateMessage;
  }

  @discourseComputed("model.topic.title")
  draftTitle(topicTitle) {
    return emojiUnescape(escapeExpression(topicTitle));
  }

  @discourseComputed
  allowUpload() {
    return authorizesOneOrMoreExtensions(
      this.currentUser.staff,
      this.siteSettings
    );
  }

  @discourseComputed()
  uploadIcon() {
    return uploadIcon(this.currentUser.staff, this.siteSettings);
  }

  // Use this to open the composer when you are not sure whether it is
  // already open and whether it already has a draft being worked on. Supports
  // options to append text once the composer is open if required.
  //
  // opts:
  //
  // - topic: if this is present, the composer will be opened with the reply
  // action and the current topic key and draft sequence
  // - fallbackToNewTopic: if true, and there is no draft and no topic,
  // the composer will be opened with the create_topic action and a new
  // topic draft key
  // - insertText: the text to append to the composer once it is opened
  // - openOpts: this object will be passed to this.open if fallbackToNewTopic is
  // true or topic is provided
  @action
  async focusComposer(opts = {}) {
    await this._openComposerForFocus(opts);
    this._focusAndInsertText(opts.insertText);
  }

  async _openComposerForFocus(opts) {
    if (this.get("model.viewOpen")) {
      return;
    }

    const opened = this.openIfDraft();
    if (opened) {
      return;
    }

    if (opts.topic) {
      return await this.open({
        action: Composer.REPLY,
        draftKey: opts.topic.get("draft_key"),
        draftSequence: opts.topic.get("draft_sequence"),
        topic: opts.topic,
        ...(opts.openOpts || {}),
      });
    }

    if (opts.fallbackToNewTopic) {
      return await this.open({
        action: Composer.CREATE_TOPIC,
        draftKey: Composer.NEW_TOPIC_KEY,
        ...(opts.openOpts || {}),
      });
    }
  }

  _focusAndInsertText(insertText) {
    scheduleOnce("afterRender", () => {
      document.querySelector("textarea.d-editor-input")?.focus();

      if (insertText) {
        this.model.appendText(insertText, null, { new_line: true });
      }
    });
  }

  @action
  updateCategory(categoryId) {
    this.model.categoryId = categoryId;
  }

  @action
  openIfDraft(event) {
    if (!this.get("model.viewDraft")) {
      return false;
    }

    // when called from shortcut, ensure we don't propagate the key to
    // the composer input title
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    this.set("model.composeState", Composer.OPEN);

    document.documentElement.style.setProperty(
      "--composer-height",
      this.get("model.composerHeight")
    );

    return true;
  }

  @action
  removeFullScreenExitPrompt() {
    this.set("model.showFullScreenExitPrompt", false);
  }

  @action
  async cancel(event) {
    event?.preventDefault();
    await this.cancelComposer();
  }

  @action
  cancelUpload(event) {
    event?.preventDefault();
    this.set("model.uploadCancelled", true);
  }

  @action
  togglePreview(event) {
    event?.preventDefault();
    this.toggleProperty("showPreview");
  }

  @action
  viewNewReply(event) {
    if (event && modKeysPressed(event).length > 0) {
      return false;
    }
    event?.preventDefault();
    DiscourseURL.routeTo(this.get("model.createdPost.url"));
    this.close();
  }

  @action
  closeComposer() {
    this.close();
  }

  @action
  async openComposer(options, post, topic) {
    await this.open(options);

    let url = post?.url || topic?.url;
    const topicTitle = topic?.title;

    if (!url || !topicTitle) {
      return;
    }

    url = `${location.protocol}//${location.host}${url}`;
    const link = `[${escapeExpression(topicTitle)}](${url})`;
    const continueDiscussion = I18n.t("post.continue_discussion", {
      postLink: link,
    });

    const reply = this.get("model.reply");
    if (reply?.includes(continueDiscussion)) {
      return;
    }

    this.model.prependText(continueDiscussion, {
      new_line: true,
    });
  }

  @action
  onPopupMenuAction(menuAction) {
    return (
      this.actions?.[menuAction]?.bind(this) || // Legacy-style contributions from themes/plugins
      this[menuAction]
    )();
  }

  @action
  storeToolbarState(toolbarEvent) {
    this.set("toolbarEvent", toolbarEvent);
  }

  @action
  typed() {
    this.checkReplyLength();
    this.model.typing();
  }

  @action
  cancelled() {
    this.hitEsc();
  }

  @action
  addLinkLookup(linkLookup) {
    this.set("linkLookup", linkLookup);
  }

  @action
  afterRefresh($preview) {
    const topic = this.get("model.topic");
    const linkLookup = this.linkLookup;

    if (!topic || !linkLookup) {
      return;
    }

    // Don't check if there's only one post
    if (topic.posts_count === 1) {
      return;
    }

    const post = this.get("model.post");
    const $links = $("a[href]", $preview);
    $links.each((idx, l) => {
      const href = l.href;
      if (href && href.length) {
        // skip links added by watched words
        if (l.dataset.word !== undefined) {
          return true;
        }

        // skip links in quotes and oneboxes
        for (let element = l; element; element = element.parentElement) {
          if (
            element.tagName === "DIV" &&
            element.classList.contains("d-editor-preview")
          ) {
            break;
          }

          if (
            element.tagName === "ASIDE" &&
            element.classList.contains("quote")
          ) {
            return true;
          }

          if (
            element.tagName === "ASIDE" &&
            element.classList.contains("onebox") &&
            href !== element.dataset["onebox-src"]
          ) {
            return true;
          }
        }

        const [linkWarn, linkInfo] = linkLookup.check(post, href);

        if (linkWarn && !this.isWhispering) {
          if (linkInfo.username === this.currentUser.username) {
            this.appEvents.trigger("composer-messages:create", {
              extraClass: "custom-body",
              templateName: "education",
              body: I18n.t("composer.duplicate_link_same_user", {
                domain: linkInfo.domain,
                post_url: topic.urlForPostNumber(linkInfo.post_number),
                ago: shortDate(linkInfo.posted_at),
              }),
            });
          } else {
            this.appEvents.trigger("composer-messages:create", {
              extraClass: "custom-body duplicate-link-message",
              templateName: "education",
              body: I18n.t("composer.duplicate_link", {
                domain: linkInfo.domain,
                username: linkInfo.username,
                post_url: topic.urlForPostNumber(linkInfo.post_number),
                ago: shortDate(linkInfo.posted_at),
              }),
            });
          }

          return false;
        }
      }
      return true;
    });
  }

  @action
  toggleWhisper() {
    this.toggleProperty("model.whisper");
  }

  @action
  toggleInvisible() {
    this.toggleProperty("model.unlistTopic");
  }

  @action
  toggleToolbar() {
    this.toggleProperty("showToolbar");
  }

  // Toggle the reply view
  @action
  async toggle() {
    this.closeAutocomplete();

    const composer = this.model;

    if (isEmpty(composer?.reply) && isEmpty(composer?.title)) {
      this.close();
    } else if (composer?.viewOpenOrFullscreen) {
      this.shrink();
    } else {
      await this.cancelComposer();
    }
  }

  @action
  fullscreenComposer() {
    this.toggleFullscreen();
    return false;
  }

  // Import a quote from the post
  @action
  async importQuote(toolbarEvent) {
    const postStream = this.get("topic.postStream");
    let postId = this.get("model.post.id");

    // If there is no current post, use the first post id from the stream
    if (!postId && postStream) {
      postId = postStream.get("stream.firstObject");
    }

    // If we're editing a post, fetch the reply when importing a quote
    if (this.get("model.editingPost")) {
      const replyToPostNumber = this.get("model.post.reply_to_post_number");
      if (replyToPostNumber) {
        const replyPost = postStream.posts.findBy(
          "post_number",
          replyToPostNumber
        );

        if (replyPost) {
          postId = replyPost.id;
        }
      }
    }

    if (!postId) {
      return;
    }

    this.set("model.loading", true);

    const post = await this.store.find("post", postId);
    const quote = buildQuote(post, post.raw, { full: true });

    toolbarEvent.addText(quote);
    this.set("model.loading", false);
  }

  @action
  saveAction(ignore, event) {
    this.save(false, {
      jump:
        !(event?.shiftKey && this.get("model.replyingToTopic")) &&
        !this.skipJumpOnSave,
    });
  }

  @action
  displayEditReason() {
    this.set("showEditReason", true);
  }

  @action
  hitEsc() {
    if (document.querySelectorAll(".emoji-picker-modal.fadeIn").length === 1) {
      this.appEvents.trigger("emoji-picker:close");
      return;
    }

    if ((this.messageCount || 0) > 0) {
      this.appEvents.trigger("composer-messages:close");
      return;
    }

    const composer = this.model;

    if (composer?.viewOpen) {
      this.shrink();
    }

    if (composer?.viewFullscreen) {
      this.toggleFullscreen();
      this.focusComposer();
    }
  }

  @action
  groupsMentioned({ name, userCount, maxMentions }) {
    if (
      this.get("model.creatingPrivateMessage") ||
      this.get("model.topic.isPrivateMessage")
    ) {
      return;
    }

    maxMentions = parseInt(maxMentions, 10);
    userCount = parseInt(userCount, 10);

    let body;
    const groupLink = getURL(`/g/${name}/members`);

    if (userCount > maxMentions) {
      body = I18n.t("composer.group_mentioned_limit", {
        group: `@${name}`,
        count: maxMentions,
        group_link: groupLink,
      });
    } else if (userCount > 0) {
      body = I18n.t("composer.group_mentioned", {
        group: `@${name}`,
        count: userCount,
        group_link: groupLink,
      });
    }

    if (body) {
      this.appEvents.trigger("composer-messages:create", {
        extraClass: "custom-body",
        templateName: "education",
        body,
      });
    }
  }

  @action
  cannotSeeMention({ name, reason, notifiedCount, isGroup }) {
    notifiedCount = parseInt(notifiedCount, 10);

    let body;
    if (isGroup) {
      body = I18n.t(`composer.cannot_see_group_mention.${reason}`, {
        group: name,
        count: notifiedCount,
      });
    } else {
      body = I18n.t(`composer.cannot_see_mention.${reason}`, {
        username: name,
      });
    }

    this.appEvents.trigger("composer-messages:create", {
      extraClass: "custom-body",
      templateName: "education",
      body,
    });
  }

  @action
  hereMention(count) {
    this.appEvents.trigger("composer-messages:create", {
      extraClass: "custom-body",
      templateName: "education",
      body: I18n.t("composer.here_mention", {
        here: this.siteSettings.here_mention,
        count,
      }),
    });
  }

  @action
  applyFormatCode() {
    this.toolbarEvent.formatCode();
  }

  @action
  applyUnorderedList() {
    this.toolbarEvent.applyList("* ", "list_item");
  }

  @action
  applyOrderedList() {
    this.toolbarEvent.applyList(
      (i) => (!i ? "1. " : `${parseInt(i, 10) + 1}. `),
      "list_item"
    );
  }

  save(force, options = {}) {
    if (this.disableSubmit) {
      return;
    }

    // Clear the warning state if we're not showing the checkbox anymore
    if (!this.showWarning) {
      this.set("model.isWarning", false);
    }

    if (this.site.mobileView && this.showPreview) {
      this.set("showPreview", false);
    }

    const composer = this.model;

    if (composer?.cantSubmitPost) {
      if (composer?.viewFullscreen) {
        this.toggleFullscreen();
      }

      this.set("lastValidatedAt", Date.now());
      return;
    }

    const topic = composer.topic;
    const slowModePost =
      topic && topic.slow_mode_seconds && topic.user_last_posted_at;
    const notEditing = this.get("model.action") !== "edit";

    // Editing a topic in slow mode is directly handled by the backend.
    if (slowModePost && notEditing) {
      if (
        cannotPostAgain(
          this.currentUser,
          topic.slow_mode_seconds,
          topic.user_last_posted_at
        )
      ) {
        const canPostAt = new moment(topic.user_last_posted_at).add(
          topic.slow_mode_seconds,
          "seconds"
        );
        const timeLeft = moment().diff(canPostAt, "seconds");
        const message = I18n.t("composer.slow_mode.error", {
          timeLeft: durationTextFromSeconds(timeLeft),
        });

        this.dialog.alert(message);
        return;
      } else {
        // Edge case where the user tries to post again immediately.
        topic.set("user_last_posted_at", new Date().toISOString());
      }
    }

    composer.set("disableDrafts", true);

    // for now handle a very narrow use case
    // if we are replying to a topic
    // AND are on on a different topic
    // AND topic is open (or we are staff)
    // --> pop the window up
    if (!force && composer.replyingToTopic) {
      const currentTopic = this.topicModel;
      const originalTopic = this.model.topic;

      if (!currentTopic) {
        this.save(true);
        return;
      }

      const topicLabelContent = function (topicOption) {
        const topicClosed = topicOption.closed
          ? `<span class="topic-status">${iconHTML("lock")}</span>`
          : "";
        const topicPinned = topicOption.pinned
          ? `<span class="topic-status">${iconHTML("thumbtack")}</span>`
          : "";
        const topicBookmarked = topicOption.bookmarked
          ? `<span class="topic-status">${iconHTML("bookmark")}</span>`
          : "";
        const topicPM =
          topicOption.archetype === "private_message"
            ? `<span class="topic-status">${iconHTML("envelope")}</span>`
            : "";

        return `<div class='topic-title'>
                  <div class="topic-title__top-line">
                    <span class='topic-statuses'>
                      ${topicPM}${topicBookmarked}${topicClosed}${topicPinned}
                    </span>
                    <span class='fancy-title'>
                      ${topicOption.fancyTitle}
                    </span>
                  </div>
                  <div class="topic-title__bottom-line">
                    ${categoryBadgeHTML(topicOption.category, {
                      link: false,
                    })}${htmlSafe(renderTags(topicOption))}
                  </div>
                </div>`;
      };

      if (
        currentTopic.id !== composer.get("topic.id") &&
        (this.isStaffUser || !currentTopic.closed)
      ) {
        this.dialog.alert({
          title: I18n.t("composer.posting_not_on_topic"),
          buttons: [
            {
              label: topicLabelContent(originalTopic),
              class: "btn-primary btn-reply-where btn-reply-on-original",
              action: () => this.save(true),
            },
            {
              label: topicLabelContent(currentTopic),
              class: "btn-reply-where btn-reply-here",
              action: () => {
                composer.setProperties({ topic: currentTopic, post: null });
                this.save(true);
              },
            },
            {
              label: I18n.t("composer.cancel"),
              class: "btn-flat btn-text btn-reply-where__cancel",
            },
          ],
          class: "reply-where-modal",
        });
        return;
      }
    }

    let staged = false;

    // TODO: This should not happen in model
    const imageSizes = {};
    document
      .querySelectorAll(
        "#reply-control .d-editor-preview img:not(.avatar, .emoji)"
      )
      .forEach((e) => {
        const src = e.src;

        if (src && src.length) {
          imageSizes[src] = { width: e.naturalWidth, height: e.naturalHeight };
        }
      });

    const promise = composer
      .save({ imageSizes, editReason: this.editReason })
      .then((result) => {
        this.appEvents.trigger("composer:saved");

        if (result.responseJson.action === "enqueued") {
          this.postWasEnqueued(result.responseJson);
          if (result.responseJson.pending_post) {
            let pendingPosts = this.get("topicController.model.pending_posts");
            if (pendingPosts) {
              pendingPosts.pushObject(result.responseJson.pending_post);
            }
          }

          return this.destroyDraft().then(() => {
            this.close();
            this.appEvents.trigger("post-stream:refresh");
            return result;
          });
        }

        if (this.get("model.editingPost")) {
          this.appEvents.trigger("composer:edited-post");
          this.appEvents.trigger("post-stream:refresh", {
            id: parseInt(result.responseJson.id, 10),
          });
          if (result.responseJson.post.post_number === 1) {
            this.appEvents.trigger("header:update-topic", composer.topic);
          }
        } else {
          this.appEvents.trigger("post-stream:refresh");
        }

        if (result.responseJson.action === "create_post") {
          this.appEvents.trigger("composer:created-post");
          this.appEvents.trigger(
            "post:highlight",
            result.payload.post_number,
            options
          );
        }

        if (this.get("model.draftKey") === Composer.NEW_TOPIC_KEY) {
          this.currentUser.set("has_topic_draft", false);
        }

        if (result.responseJson.route_to) {
          // TODO: await this:
          this.destroyDraft();
          if (result.responseJson.message) {
            return this.dialog.alert({
              message: result.responseJson.message,
              didConfirm: () => {
                DiscourseURL.routeTo(result.responseJson.route_to);
              },
            });
          }
          return DiscourseURL.routeTo(result.responseJson.route_to);
        }

        this.close();

        this.currentUser.set("any_posts", true);

        const post = result.target;

        if (post && !staged && options.jump !== false) {
          DiscourseURL.routeTo(post.url, {
            keepFilter: true,
            skipIfOnScreen: true,
          });
        }
      })
      .catch((error) => {
        composer.set("disableDrafts", false);
        if (error) {
          this.appEvents.one("composer:will-open", () => {
            if (
              _composerSaveErrorCallbacks.length === 0 ||
              !_composerSaveErrorCallbacks
                .map((c) => {
                  return c.call(this, error);
                })
                .some((i) => {
                  return i;
                })
            ) {
              this.dialog.alert(error);
            }
          });
        }
      });

    if (
      this.router.currentRouteName.split(".")[0] === "topic" &&
      composer.get("topic.id") === this.get("topicModel.id")
    ) {
      staged = composer.get("stagedPost");
    }

    this.appEvents.trigger("post-stream:posted", staged);

    this.messageBus.pause();
    promise.finally(() => this.messageBus.resume());

    return promise;
  }

  @action
  postWasEnqueued(details) {
    showModal("post-enqueued", {
      model: details,
      title: "review.approval.title",
    });
  }

  // Notify the composer messages controller that a reply has been typed. Some
  // messages only appear after typing.
  checkReplyLength() {
    if (!isEmpty("model.reply")) {
      this.appEvents.trigger("composer:typed-reply");
    }
  }

  /**
    Open the composer view

    @method open
    @param {Object} opts Options for creating a post
      @param {String} opts.action The action we're performing: edit, reply, createTopic, createSharedDraft, privateMessage
      @param {String} opts.draftKey
      @param {Post} [opts.post] The post we're replying to
      @param {Topic} [opts.topic] The topic we're replying to
      @param {String} [opts.quote] If we're opening a reply from a quote, the quote we're making
      @param {Boolean} [opts.ignoreIfChanged]
      @param {Boolean} [opts.disableScopedCategory]
      @param {Number} [opts.categoryId] Sets `scopedCategoryId` and `categoryId` on the Composer model
      @param {Number} [opts.prioritizedCategoryId]
      @param {String} [opts.draftSequence]
      @param {Boolean} [opts.skipDraftCheck]
      @param {Boolean} [opts.skipJumpOnSave] Option to skip navigating to the post when saved in this composer session
  **/
  async open(opts = {}) {
    if (!opts.draftKey) {
      throw new Error("composer opened without a proper draft key");
    }

    let composerModel = this.model;

    if (
      opts.ignoreIfChanged &&
      composerModel &&
      composerModel.composeState !== Composer.CLOSED
    ) {
      return;
    }

    this.setProperties({
      showEditReason: false,
      editReason: null,
      scopedCategoryId: null,
      prioritizedCategoryId: null,
      skipAutoSave: true,
    });

    this.set("skipJumpOnSave", !!opts.skipJumpOnSave);

    // Scope the categories drop down to the category we opened the composer with.
    if (opts.categoryId && !opts.disableScopedCategory) {
      const category = this.site.categories.findBy("id", opts.categoryId);
      if (category) {
        this.set("scopedCategoryId", opts.categoryId);
      }
    }

    if (opts.prioritizedCategoryId) {
      const category = this.site.categories.findBy(
        "id",
        opts.prioritizedCategoryId
      );
      if (category) {
        this.set("prioritizedCategoryId", opts.prioritizedCategoryId);
      }
    }

    // If we want a different draft than the current composer, close it and clear our model.
    if (
      composerModel &&
      opts.draftKey !== composerModel.draftKey &&
      composerModel.composeState === Composer.DRAFT
    ) {
      this.close();
      composerModel = null;
    }

    try {
      if (composerModel?.replyDirty) {
        // If we're already open, we don't have to do anything
        if (
          composerModel.composeState === Composer.OPEN &&
          composerModel.draftKey === opts.draftKey &&
          !opts.action
        ) {
          return;
        }

        // If it's the same draft, just open it up again.
        if (
          composerModel.composeState === Composer.DRAFT &&
          composerModel.draftKey === opts.draftKey
        ) {
          composerModel.set("composeState", Composer.OPEN);
          if (!opts.action) {
            return;
          }
        }

        await this.cancelComposer();
        await this.open(opts);
        return;
      }

      if (composerModel && composerModel.action !== opts.action) {
        composerModel.setProperties({ unlistTopic: false, whisper: false });
      }

      // we need a draft sequence for the composer to work
      if (opts.draftSequence === undefined) {
        let data = await Draft.get(opts.draftKey);

        if (opts.skipDraftCheck) {
          data.draft = undefined;
        } else {
          data = await this.confirmDraftAbandon(data);
        }

        opts.draft ||= data.draft;
        opts.draftSequence = data.draft_sequence;

        await this._setModel(composerModel, opts);
        return;
      }

      // otherwise, do the draft check async
      if (!opts.draft && !opts.skipDraftCheck) {
        let data = await Draft.get(opts.draftKey);
        data = await this.confirmDraftAbandon(data);

        if (data.draft) {
          opts.draft = data.draft;
          opts.draftSequence = data.draft_sequence;
          await this.open(opts);
        }
      }

      await this._setModel(composerModel, opts);
    } finally {
      this.skipAutoSave = false;
    }
  }

  // Given a potential instance and options, set the model for this composer.
  async _setModel(optionalComposerModel, opts) {
    this.set("linkLookup", null);

    let composerModel;
    if (opts.draft) {
      composerModel = await loadDraft(this.store, opts);

      if (!composerModel) {
        throw new Error("draft was not found");
      }
    } else {
      const model =
        optionalComposerModel || this.store.createRecord("composer");

      await model.open(opts);
      composerModel = model;
    }

    this.set("model", composerModel);

    composerModel.setProperties({
      composeState: Composer.OPEN,
      isWarning: false,
      hasTargetGroups: opts.hasGroups,
      warningsDisabled: opts.warningsDisabled,
    });

    if (!this.model.targetRecipients) {
      if (opts.usernames) {
        deprecated("`usernames` is deprecated, use `recipients` instead.", {
          id: "discourse.composer.usernames",
        });
        this.model.set("targetRecipients", opts.usernames);
      } else if (opts.recipients) {
        this.model.set("targetRecipients", opts.recipients);
      }
    }

    if (
      opts.topicTitle &&
      opts.topicTitle.length <= this.siteSettings.max_topic_title_length
    ) {
      this.model.set("title", opts.topicTitle);
    }

    if (opts.topicCategoryId) {
      this.model.set("categoryId", opts.topicCategoryId);
    }

    if (opts.topicTags && this.site.can_tag_topics) {
      let tags = escapeExpression(opts.topicTags)
        .split(",")
        .slice(0, this.siteSettings.max_tags_per_topic);

      tags.forEach(
        (tag, index, array) =>
          (array[index] = tag.substring(0, this.siteSettings.max_tag_length))
      );

      this.model.set("tags", tags);
    }

    if (opts.topicBody) {
      this.model.set("reply", opts.topicBody);
    }

    const defaultComposerHeight = this._getDefaultComposerHeight();

    this.set("model.composerHeight", defaultComposerHeight);
    document.documentElement.style.setProperty(
      "--composer-height",
      defaultComposerHeight
    );
  }

  _getDefaultComposerHeight() {
    if (this.keyValueStore.getItem("composerHeight")) {
      return this.keyValueStore.getItem("composerHeight");
    }

    // The two custom properties below can be overriden by themes/plugins to set different default composer heights.
    if (this.model.action === "reply") {
      return "var(--reply-composer-height, 300px)";
    } else {
      return "var(--new-topic-composer-height, 400px)";
    }
  }

  async destroyDraft(draftSequence = null) {
    const key = this.get("model.draftKey");
    if (!key) {
      return;
    }

    if (key === Composer.NEW_TOPIC_KEY) {
      this.currentUser.set("has_topic_draft", false);
    }

    if (this._saveDraftPromise) {
      await this._saveDraftPromise;
      return await this.destroyDraft();
    }

    const sequence = draftSequence || this.get("model.draftSequence");
    await Draft.clear(key, sequence);
    this.appEvents.trigger("draft:destroyed", key);
  }

  confirmDraftAbandon(data) {
    if (!data.draft) {
      return data;
    }

    // do not show abandon dialog if old draft is clean
    const draft = JSON.parse(data.draft);
    if (draft.reply === draft.originalText) {
      data.draft = null;
      return data;
    }

    if (!_checkDraftPopup) {
      data.draft = null;
      return data;
    }

    return new Promise((resolve) => {
      this.dialog.alert({
        message: I18n.t("drafts.abandon.confirm"),
        buttons: [
          {
            label: I18n.t("drafts.abandon.yes_value"),
            class: "btn-danger",
            icon: "far-trash-alt",
            action: () => {
              this.destroyDraft(data.draft_sequence).finally(() => {
                data.draft = null;
                resolve(data);
              });
            },
          },
          {
            label: I18n.t("drafts.abandon.no_value"),
            class: "btn-resume-editing",
            action: () => resolve(data),
          },
        ],
      });
    });
  }

  cancelComposer() {
    this.skipAutoSave = true;

    if (this._saveDraftDebounce) {
      cancel(this._saveDraftDebounce);
    }

    return new Promise((resolve) => {
      if (this.get("model.hasMetaData") || this.get("model.replyDirty")) {
        const modal = showModal("discard-draft", {
          model: this.model,
          modalClass: "discard-draft-modal",
        });
        modal.setProperties({
          onDestroyDraft: () => {
            return this.destroyDraft()
              .then(() => {
                this.model.clearState();
                this.close();
              })
              .finally(() => {
                this.appEvents.trigger("composer:cancelled");
                resolve();
              });
          },
          onSaveDraft: () => {
            this._saveDraft();
            this.model.clearState();
            this.close();
            this.appEvents.trigger("composer:cancelled");
            return resolve();
          },
        });
      } else {
        // it is possible there is some sort of crazy draft with no body ... just give up on it
        this.destroyDraft()
          .then(() => {
            this.model.clearState();
            this.close();
          })
          .finally(() => {
            this.appEvents.trigger("composer:cancelled");
            resolve();
          });
      }
    }).finally(() => {
      this.skipAutoSave = false;
    });
  }

  shrink() {
    if (
      this.get("model.replyDirty") ||
      (this.get("model.canEditTitle") && this.get("model.titleDirty"))
    ) {
      this.collapse();
    } else {
      this.close();
    }
  }

  _saveDraft() {
    if (!this.model) {
      return;
    }

    if (this.model.draftSaving) {
      this._saveDraftDebounce = discourseDebounce(this, this._saveDraft, 2000);
    } else {
      this._saveDraftPromise = this.model
        .saveDraft(this.currentUser)
        .finally(() => {
          this._lastDraftSaved = Date.now();
          this._saveDraftPromise = null;
        });
    }
  }

  @observes("model.reply", "model.title")
  _shouldSaveDraft() {
    if (
      this.model &&
      !this.model.loading &&
      !this.skipAutoSave &&
      !this.model.disableDrafts
    ) {
      if (!this._lastDraftSaved) {
        // pretend so we get a save unconditionally in 15 secs
        this._lastDraftSaved = Date.now();
      }
      if (Date.now() - this._lastDraftSaved > 15000) {
        this._saveDraft();
      } else {
        this._saveDraftDebounce = discourseDebounce(
          this,
          this._saveDraft,
          2000
        );
      }
    }
  }

  @discourseComputed("model.categoryId", "lastValidatedAt")
  categoryValidation(categoryId, lastValidatedAt) {
    if (!this.siteSettings.allow_uncategorized_topics && !categoryId) {
      return EmberObject.create({
        failed: true,
        reason: I18n.t("composer.error.category_missing"),
        lastShownAt: lastValidatedAt,
      });
    }
  }

  @discourseComputed("model.category", "model.tags", "lastValidatedAt")
  tagValidation(category, tags, lastValidatedAt) {
    const tagsArray = tags || [];
    if (this.site.can_tag_topics && !this.currentUser.staff && category) {
      // category.minimumRequiredTags incorporates both minimum_required_tags, and required_tag_groups
      if (category.minimumRequiredTags > tagsArray.length) {
        return EmberObject.create({
          failed: true,
          reason: I18n.t("composer.error.tags_missing", {
            count: category.minimumRequiredTags,
          }),
          lastShownAt: lastValidatedAt,
        });
      }
    }
  }

  collapse() {
    this._saveDraft();
    this.set("model.composeState", Composer.DRAFT);
    document.documentElement.style.setProperty("--composer-height", "40px");
  }

  toggleFullscreen() {
    this._saveDraft();

    const composer = this.model;

    if (composer?.viewFullscreen) {
      composer?.set("composeState", Composer.OPEN);
    } else {
      composer?.set("composeState", Composer.FULLSCREEN);
      composer?.set("showFullScreenExitPrompt", true);
    }
  }

  @discourseComputed("model.viewFullscreen", "model.showFullScreenExitPrompt")
  showFullScreenPrompt(isFullscreen, showExitPrompt) {
    return isFullscreen && showExitPrompt && !this.capabilities.touch;
  }

  close() {
    // the 'fullscreen-composer' class is added to remove scrollbars from the
    // document while in fullscreen mode. If the composer is closed for any reason
    // this class should be removed

    const elem = document.querySelector("html");
    elem.classList.remove("fullscreen-composer");
    elem.classList.remove("composer-open");

    document.activeElement?.blur();
    document.documentElement.style.removeProperty("--composer-height");
    this.setProperties({ model: null, lastValidatedAt: null });
  }

  closeAutocomplete() {
    $(".d-editor-input").autocomplete({ cancel: true });
  }

  @discourseComputed("model.action")
  canEdit(modelAction) {
    return modelAction === "edit" && this.currentUser.can_edit;
  }

  @discourseComputed("model.composeState")
  visible(state) {
    return state && state !== "closed";
  }

  clearLastValidatedAt() {
    this.set("lastValidatedAt", null);
  }
}
