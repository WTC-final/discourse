import { withPluginApi } from "discourse/lib/plugin-api";
import showModal from "discourse/lib/show-modal";

const APPLE =
  navigator.platform.startsWith("Mac") || navigator.platform === "iPhone";
export const KEY_MODIFIER = APPLE ? "meta" : "ctrl";

export default {
  name: "chat-keyboard-shortcuts",

  initialize(container) {
    const chatService = container.lookup("service:chat");
    if (!chatService.userCanChat) {
      return;
    }

    const router = container.lookup("service:router");
    const appEvents = container.lookup("service:app-events");
    const chatStateManager = container.lookup("service:chat-state-manager");
    const chatThreadPane = container.lookup("service:chat-thread-pane");
    const chatThreadListPane = container.lookup(
      "service:chat-thread-list-pane"
    );
    const chatChannelsManager = container.lookup(
      "service:chat-channels-manager"
    );
    const openChannelSelector = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (document.getElementById("chat-channel-selector-modal-inner")) {
        appEvents.trigger("chat-channel-selector-modal:close");
      } else {
        showModal("chat-channel-selector-modal");
      }
    };

    const handleMoveUpShortcut = (e) => {
      e.preventDefault();
      e.stopPropagation();
      chatService.switchChannelUpOrDown("up");
    };

    const handleMoveDownShortcut = (e) => {
      e.preventDefault();
      e.stopPropagation();
      chatService.switchChannelUpOrDown("down");
    };

    const isChatComposer = (el) =>
      el.classList.contains("chat-composer__input");
    const isInputSelection = (el) => {
      const inputs = ["input", "textarea", "select", "button"];
      const elementTagName = el?.tagName.toLowerCase();

      if (inputs.includes(elementTagName)) {
        return false;
      }
      return true;
    };
    const modifyComposerSelection = (event, type) => {
      if (!isChatComposer(event.target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      appEvents.trigger("chat:modify-selection", event, {
        type,
        context: event.target.dataset.chatComposerContext,
      });
    };

    const openInsertLinkModal = (event) => {
      if (!isChatComposer(event.target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      appEvents.trigger("chat:open-insert-link-modal", event, {
        context: event.target.dataset.chatComposerContext,
      });
    };

    const openChatDrawer = (event) => {
      if (!isInputSelection(event.target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      chatStateManager.prefersDrawer();
      router.transitionTo(chatStateManager.lastKnownChatURL || "chat");
    };

    const closeChat = (event) => {
      if (chatStateManager.isDrawerActive) {
        event.preventDefault();
        event.stopPropagation();
        appEvents.trigger("chat:toggle-close", event);
        return;
      }

      if (chatThreadPane.isOpened) {
        event.preventDefault();
        event.stopPropagation();
        chatThreadPane.close();
        return;
      }

      if (chatThreadListPane.isOpened) {
        event.preventDefault();
        event.stopPropagation();
        chatThreadListPane.close();
        return;
      }
    };

    const markAllChannelsRead = (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (chatStateManager.isActive) {
        chatChannelsManager.markAllChannelsRead();
      }
    };

    withPluginApi("0.12.1", (api) => {
      api.addKeyboardShortcut(`${KEY_MODIFIER}+k`, openChannelSelector, {
        global: true,
        help: {
          category: "chat",
          name: "chat.keyboard_shortcuts.open_quick_channel_selector",
          definition: {
            keys1: ["meta", "k"],
            keysDelimiter: "plus",
          },
        },
      });
      api.addKeyboardShortcut("alt+up", handleMoveUpShortcut, {
        global: true,
        help: {
          category: "chat",
          name: "chat.keyboard_shortcuts.switch_channel_arrows",
          definition: {
            keys1: ["alt", "&uarr;"],
            keys2: ["alt", "&darr;"],
            keysDelimiter: "plus",
            shortcutsDelimiter: "slash",
          },
        },
      });

      api.addKeyboardShortcut("alt+down", handleMoveDownShortcut, {
        global: true,
      });
      api.addKeyboardShortcut(
        `${KEY_MODIFIER}+b`,
        (event) => modifyComposerSelection(event, "bold"),
        {
          global: true,
          help: {
            category: "chat",
            name: "chat.keyboard_shortcuts.composer_bold",
            definition: {
              keys1: ["meta", "b"],
              keysDelimiter: "plus",
            },
          },
        }
      );
      api.addKeyboardShortcut(
        `${KEY_MODIFIER}+i`,
        (event) => modifyComposerSelection(event, "italic"),
        {
          global: true,
          help: {
            category: "chat",
            name: "chat.keyboard_shortcuts.composer_italic",
            definition: {
              keys1: ["meta", "i"],
              keysDelimiter: "plus",
            },
          },
        }
      );
      api.addKeyboardShortcut(
        `${KEY_MODIFIER}+e`,
        (event) => modifyComposerSelection(event, "code"),
        {
          global: true,
          help: {
            category: "chat",
            name: "chat.keyboard_shortcuts.composer_code",
            definition: {
              keys1: ["meta", "e"],
              keysDelimiter: "plus",
            },
          },
        }
      );
      api.addKeyboardShortcut(
        `${KEY_MODIFIER}+l`,
        (event) => openInsertLinkModal(event),
        {
          global: true,
          help: {
            category: "chat",
            name: "chat.keyboard_shortcuts.open_insert_link_modal",
            definition: {
              keys1: ["meta", "l"],
              keysDelimiter: "plus",
            },
          },
        }
      );
      api.addKeyboardShortcut(`-`, (event) => openChatDrawer(event), {
        global: true,
        help: {
          category: "chat",
          name: "chat.keyboard_shortcuts.drawer_open",
          definition: {
            keys1: ["-"],
          },
        },
      });
      api.addKeyboardShortcut("esc", (event) => closeChat(event), {
        global: true,
        help: {
          category: "chat",
          name: "chat.keyboard_shortcuts.drawer_close",
          definition: {
            keys1: ["esc"],
          },
        },
      });
      api.addKeyboardShortcut(
        `shift+esc`,
        (event) => markAllChannelsRead(event),
        {
          global: true,
          help: {
            category: "chat",
            name: "chat.keyboard_shortcuts.mark_all_channels_read",
            definition: {
              keys1: ["shift", "esc"],
              keysDelimiter: "plus",
            },
          },
        }
      );
    });
  },
};
