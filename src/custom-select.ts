export interface SelectOption {
  value: string;
  label: string;
  icon?: string;
  description?: string;
  disabled?: boolean;
}

export interface CustomSelectConfig {
  controlId?: string;
  labelId?: string;
}

let selectId = 0;

/** An accessible popup list that does not use the browser's native select menu. */
export class CustomSelect {
  private readonly containerEl: HTMLElement;
  private readonly triggerEl: HTMLButtonElement;
  private readonly valueEl: HTMLElement;
  private readonly menuEl: HTMLElement;
  private readonly optionEls: HTMLElement[] = [];
  private readonly abortController = new AbortController();
  private selectedIndex: number;
  private activeIndex: number;
  private isOpen = false;

  constructor(
    parentEl: HTMLElement,
    private readonly options: SelectOption[],
    initialValue: string,
    private readonly onChange: (value: string) => void,
    config: CustomSelectConfig = {},
  ) {
    const instanceId = ++selectId;
    const controlId = config.controlId ?? `nemotron-custom-select-${instanceId}`;
    const menuId = `${controlId}-menu`;

    this.selectedIndex = this.findInitialIndex(initialValue);
    this.activeIndex = this.selectedIndex;
    this.containerEl = parentEl.createDiv({ cls: "nemotron-custom-select-container" });

    this.triggerEl = this.containerEl.createEl("button", {
      cls: "nemotron-custom-select-trigger",
      attr: {
        id: controlId,
        type: "button",
        "aria-haspopup": "listbox",
        "aria-expanded": "false",
        "aria-controls": menuId,
      },
    });
    if (!options.some((option) => !option.disabled)) {
      this.triggerEl.disabled = true;
      this.triggerEl.setAttribute("aria-disabled", "true");
    }
    if (config.labelId) this.triggerEl.setAttribute("aria-labelledby", config.labelId);

    const triggerContent = this.triggerEl.createSpan({ cls: "nemotron-select-left" });
    this.valueEl = triggerContent.createSpan({ cls: "nemotron-select-label" });
    this.triggerEl.createSpan({ cls: "nemotron-select-chevron", text: "⌄", attr: { "aria-hidden": "true" } });

    this.menuEl = this.containerEl.createDiv({
      cls: "nemotron-custom-select-menu",
      attr: { id: menuId, role: "listbox", tabindex: "-1" },
    });
    this.menuEl.hidden = true;
    if (config.labelId) this.menuEl.setAttribute("aria-labelledby", config.labelId);

    options.forEach((option, index) => this.createOption(option, index, menuId));
    this.renderSelection();

    const signal = this.abortController.signal;
    this.triggerEl.addEventListener("click", () => this.toggle(), { signal });
    this.triggerEl.addEventListener("keydown", (event) => this.onTriggerKeyDown(event), { signal });
    this.menuEl.addEventListener("keydown", (event) => this.onMenuKeyDown(event), { signal });
  }

  public setValue(value: string): void {
    const index = this.options.findIndex((option) => option.value === value && !option.disabled);
    if (index < 0) return;
    this.selectedIndex = index;
    this.activeIndex = index;
    this.renderSelection();
  }

  public destroy(): void {
    this.close(false);
    this.abortController.abort();
  }

  private findInitialIndex(value: string): number {
    const requestedIndex = this.options.findIndex((option) => option.value === value && !option.disabled);
    if (requestedIndex >= 0) return requestedIndex;
    return Math.max(0, this.options.findIndex((option) => !option.disabled));
  }

  private createOption(option: SelectOption, index: number, menuId: string): void {
    const optionEl = this.menuEl.createDiv({
      cls: `nemotron-select-option${option.disabled ? " is-disabled" : ""}`,
      attr: {
        id: `${menuId}-option-${index}`,
        role: "option",
        "aria-selected": "false",
        ...(option.disabled ? { "aria-disabled": "true" } : {}),
      },
    });

    const header = optionEl.createDiv({ cls: "nemotron-option-header" });
    const titleGroup = header.createDiv({ cls: "nemotron-option-title-group" });
    if (option.icon) titleGroup.createSpan({ cls: "nemotron-option-icon", text: option.icon, attr: { "aria-hidden": "true" } });
    titleGroup.createSpan({ cls: "nemotron-option-title", text: option.label });
    header.createSpan({ cls: "nemotron-option-check", text: "✓", attr: { "aria-hidden": "true" } });
    if (option.description) optionEl.createDiv({ cls: "nemotron-option-desc", text: option.description });

    if (!option.disabled) {
      optionEl.addEventListener("pointermove", () => this.setActiveIndex(index), { signal: this.abortController.signal });
      optionEl.addEventListener("click", () => this.commit(index), { signal: this.abortController.signal });
    }
    this.optionEls.push(optionEl);
  }

  private toggle(): void {
    if (this.isOpen) this.close(false);
    else this.open();
  }

  private open(preferredIndex: number = this.selectedIndex): void {
    if (this.isOpen || !this.options.some((option) => !option.disabled)) return;
    this.isOpen = true;
    this.menuEl.hidden = false;
    this.triggerEl.addClass("is-open");
    this.triggerEl.setAttribute("aria-expanded", "true");
    this.setActiveIndex(preferredIndex);
    document.addEventListener("pointerdown", this.onDocumentPointerDown, true);
    document.addEventListener("focusin", this.onDocumentFocusIn, true);
    this.menuEl.focus({ preventScroll: true });
  }

  private close(restoreTriggerFocus: boolean): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.menuEl.hidden = true;
    this.menuEl.removeAttribute("aria-activedescendant");
    this.triggerEl.removeClass("is-open");
    this.triggerEl.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", this.onDocumentPointerDown, true);
    document.removeEventListener("focusin", this.onDocumentFocusIn, true);
    if (restoreTriggerFocus) this.triggerEl.focus({ preventScroll: true });
  }

  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    if (!this.containerEl.contains(event.target as Node)) this.close(false);
  };

  private readonly onDocumentFocusIn = (event: FocusEvent): void => {
    if (!this.containerEl.contains(event.target as Node)) this.close(false);
  };

  private onTriggerKeyDown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const start = this.isOpen ? this.activeIndex : this.selectedIndex;
      const next = this.findEnabledIndex(start, direction);
      if (!this.isOpen) this.open(next);
      else this.setActiveIndex(next);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = this.findEdgeIndex(event.key === "Home");
      if (!this.isOpen) this.open(next);
      else this.setActiveIndex(next);
    } else if (event.key === "Escape" && this.isOpen) {
      event.preventDefault();
      this.close(true);
    }
  }

  private onMenuKeyDown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      this.setActiveIndex(this.findEnabledIndex(this.activeIndex, event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      this.setActiveIndex(this.findEdgeIndex(event.key === "Home"));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.commit(this.activeIndex);
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.close(true);
    } else if (event.key === "Tab") {
      this.close(false);
    }
  }

  private findEnabledIndex(start: number, direction: 1 | -1): number {
    let index = start;
    for (let count = 0; count < this.options.length; count++) {
      index = (index + direction + this.options.length) % this.options.length;
      if (!this.options[index]?.disabled) return index;
    }
    return start;
  }

  private findEdgeIndex(fromStart: boolean): number {
    const indexes = this.options.map((_, index) => index);
    if (!fromStart) indexes.reverse();
    return indexes.find((index) => !this.options[index]?.disabled) ?? this.selectedIndex;
  }

  private setActiveIndex(index: number): void {
    if (index < 0 || this.options[index]?.disabled) return;
    this.activeIndex = index;
    this.optionEls.forEach((element, optionIndex) => element.toggleClass("is-active", optionIndex === index));
    const activeEl = this.optionEls[index];
    if (!activeEl) return;
    this.menuEl.setAttribute("aria-activedescendant", activeEl.id);
    activeEl.scrollIntoView({ block: "nearest" });
  }

  private commit(index: number): void {
    const option = this.options[index];
    if (!option || option.disabled) return;
    const changed = index !== this.selectedIndex;
    this.selectedIndex = index;
    this.activeIndex = index;
    this.renderSelection();
    this.close(true);
    if (changed) this.onChange(option.value);
  }

  private renderSelection(): void {
    const selected = this.options[this.selectedIndex];
    if (!selected) return;
    this.valueEl.empty();
    if (selected.icon) this.valueEl.createSpan({ cls: "nemotron-select-icon", text: selected.icon, attr: { "aria-hidden": "true" } });
    this.valueEl.createSpan({ text: selected.label });
    this.optionEls.forEach((element, index) => {
      const isSelected = index === this.selectedIndex;
      element.toggleClass("is-selected", isSelected);
      element.setAttribute("aria-selected", String(isSelected));
    });
  }
}
