import Modifier from "ember-modifier";
import { registerDestructor } from "@ember/destroyable";
import { inject as service } from "@ember/service";
import { bind } from "discourse-common/utils/decorators";
import { cancel } from "@ember/runloop";
import discourseLater from "discourse-common/lib/later";

function cancelEvent(event) {
  event.stopPropagation();
  event.preventDefault();
}

export default class ChatOnLongPress extends Modifier {
  @service capabilities;
  @service site;

  constructor(owner, args) {
    super(owner, args);
    registerDestructor(this, (instance) => instance.cleanup());
  }

  get enabled() {
    return this.capabilities.touch && this.site.mobileView;
  }

  modify(element, [onLongPressStart, onLongPressEnd, onLongPressCancel]) {
    if (!this.enabled) {
      return;
    }

    this.element = element;
    this.onLongPressStart = onLongPressStart || (() => {});
    this.onLongPressEnd = onLongPressEnd || (() => {});
    this.onLongPressCancel = onLongPressCancel || (() => {});

    element.addEventListener("touchstart", this.handleTouchStart, {
      passive: true,
    });
  }

  @bind
  onCancel() {
    cancel(this.timeout);
    this.element.removeEventListener("touchmove", this.onCancel);
    this.element.removeEventListener("touchend", this.onCancel);
    this.element.removeEventListener("touchcancel", this.onCancel);
    this.onLongPressCancel(this.element);
  }

  @bind
  handleTouchStart(event) {
    if (event.touches.length > 1) {
      return;
    }

    this.onLongPressStart(this.element, event);

    this.element.addEventListener("touchmove", this.onCancel);
    this.element.addEventListener("touchend", this.onCancel);
    this.element.addEventListener("touchcancel", this.onCancel);

    this.timeout = discourseLater(() => {
      if (this.isDestroying || this.isDestroyed) {
        return;
      }

      this.onLongPressEnd(this.element, event);
      this.element.addEventListener("touchend", cancelEvent, {
        once: true,
      });
    }, 400);
  }

  cleanup() {
    if (!this.enabled) {
      return;
    }

    this.onCancel();
  }
}
