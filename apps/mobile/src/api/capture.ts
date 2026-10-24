import type { CameraView } from "expo-camera";
import type { RefObject } from "react";

export interface FaceCapture { image: string; livenessImages: string[] }
/** Capture seven fresh camera frames; the middle frame is the 1:1 embedding selfie. */
export async function captureFaceSequence(camera: RefObject<CameraView | null>): Promise<FaceCapture> {
  const frames: string[] = [];
  for (let index = 0; index < 7; index += 1) {
    const picture = await camera.current?.takePictureAsync({ quality: 0.55, base64: true, skipProcessing: true });
    if (!picture?.base64) throw new Error("The camera did not return a frame. Please try again.");
    frames.push(picture.base64);
    if (index < 6) await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return { image: frames[3]!, livenessImages: frames };
}
