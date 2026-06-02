declare module "html2canvas" {
  const html2canvas: (element: HTMLElement, options?: Record<string, unknown>) => Promise<HTMLCanvasElement>;
  export default html2canvas;
}

declare module "jspdf" {
  export class jsPDF {
    constructor(orientation?: string, unit?: string, format?: string);
    addImage(imageData: string, format: string, x: number, y: number, width: number, height: number): void;
    addPage(): void;
    save(filename: string): void;
    internal: {
      pageSize: {
        getWidth(): number;
        getHeight(): number;
      };
    };
  }
}
