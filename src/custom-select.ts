export interface SelectOption {
  value: string;
  label: string;
  icon?: string;
  description?: string;
  disabled?: boolean;
}

export class CustomSelect {
  private containerEl: HTMLElement;
  private options: SelectOption[];
  private selectedValue: string;
  private onChange: (value: string) => void;
  private isOpen: boolean = false;

  private triggerEl: HTMLElement;
  private menuEl: HTMLElement;
  private labelSpan: HTMLElement;
  private iconSpan: HTMLElement;

  constructor(
    parentEl: HTMLElement,
    options: SelectOption[],
    initialValue: string,
    onChange: (value: string) => void
  ) {
    this.options = options;
    this.selectedValue = initialValue;
    this.onChange = onChange;

    this.containerEl = parentEl.createDiv({ cls: "nemotron-custom-select-container" });
    this.render();
  }

  private render() {
    this.containerEl.empty();

    const selectedOption = this.options.find((o) => o.value === this.selectedValue) || this.options[0];

    // Trigger button
    this.triggerEl = this.containerEl.createDiv({ cls: "nemotron-custom-select-trigger" });
    this.triggerEl.setAttribute("tabindex", "0");
    this.triggerEl.setAttribute("role", "combobox");
    this.triggerEl.setAttribute("aria-expanded", "false");

    const leftGroup = this.triggerEl.createDiv({ cls: "nemotron-select-left" });
    this.iconSpan = leftGroup.createSpan({ cls: "nemotron-select-icon" });
    if (selectedOption?.icon) {
      this.iconSpan.setText(selectedOption.icon);
    } else {
      this.iconSpan.style.display = "none";
    }

    this.labelSpan = leftGroup.createSpan({ cls: "nemotron-select-label", text: selectedOption?.label || "" });

    const chevron = this.triggerEl.createSpan({ cls: "nemotron-select-chevron", text: "▼" });

    // Menu list
    this.menuEl = this.containerEl.createDiv({ cls: "nemotron-custom-select-menu" });
    this.menuEl.style.display = "none";

    this.renderOptions();

    // Event listeners
    this.triggerEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleMenu();
    });

    this.triggerEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.toggleMenu();
      } else if (e.key === "Escape" && this.isOpen) {
        this.closeMenu();
      }
    });

    // Close on click outside
    document.addEventListener("click", this.handleDocumentClick);
  }

  private renderOptions() {
    this.menuEl.empty();

    this.options.forEach((opt) => {
      const optionEl = this.menuEl.createDiv({
        cls: `nemotron-select-option ${opt.value === this.selectedValue ? "is-selected" : ""} ${opt.disabled ? "is-disabled" : ""}`,
      });

      const header = optionEl.createDiv({ cls: "nemotron-option-header" });
      const titleGroup = header.createDiv({ cls: "nemotron-option-title-group" });

      if (opt.icon) {
        titleGroup.createSpan({ text: opt.icon, cls: "nemotron-option-icon" });
      }

      titleGroup.createSpan({ text: opt.label, cls: "nemotron-option-title" });

      if (opt.value === this.selectedValue) {
        header.createSpan({ text: "(Selected)", cls: "nemotron-option-check" });
      }

      if (opt.description) {
        optionEl.createDiv({ text: opt.description, cls: "nemotron-option-desc" });
      }

      if (!opt.disabled) {
        optionEl.addEventListener("click", (e) => {
          e.stopPropagation();
          this.selectOption(opt.value);
        });
      }
    });
  }

  private selectOption(value: string) {
    if (this.selectedValue === value) {
      this.closeMenu();
      return;
    }

    this.selectedValue = value;
    const selectedOption = this.options.find((o) => o.value === value);

    if (selectedOption) {
      this.labelSpan.setText(selectedOption.label);
      if (selectedOption.icon) {
        this.iconSpan.setText(selectedOption.icon);
        this.iconSpan.style.display = "inline";
      } else {
        this.iconSpan.style.display = "none";
      }
    }

    this.renderOptions();
    this.closeMenu();
    this.onChange(value);
  }

  private toggleMenu() {
    if (this.isOpen) {
      this.closeMenu();
    } else {
      this.openMenu();
    }
  }

  private openMenu() {
    this.isOpen = true;
    this.menuEl.style.display = "block";
    this.triggerEl.addClass("is-open");
    this.triggerEl.setAttribute("aria-expanded", "true");
  }

  private closeMenu() {
    this.isOpen = false;
    this.menuEl.style.display = "none";
    this.triggerEl.removeClass("is-open");
    this.triggerEl.setAttribute("aria-expanded", "false");
  }

  private handleDocumentClick = (e: MouseEvent) => {
    if (!this.containerEl.contains(e.target as Node)) {
      if (this.isOpen) {
        this.closeMenu();
      }
    }
  };

  public setValue(value: string) {
    this.selectOption(value);
  }

  public destroy() {
    document.removeEventListener("click", this.handleDocumentClick);
  }
}
