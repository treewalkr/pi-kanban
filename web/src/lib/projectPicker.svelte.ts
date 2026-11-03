export class ProjectPickerStore {
  open = $state(false);
  openModal(): void {
    this.open = true;
  }
  close(): void {
    this.open = false;
  }
}

export const projectPicker = new ProjectPickerStore();
