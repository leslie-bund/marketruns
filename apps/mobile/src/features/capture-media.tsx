import { useRef, useState } from "react";
import { Alert, Image, Pressable, Text, View } from "react-native";
import { CameraView, useCameraPermissions, useMicrophonePermissions } from "expo-camera";
import { captureUrl, participantHeaders, sessionHeaders, uploadCapture } from "../api";
import { ProductVideo } from "./product-video";
import { Button, Pill, Section, colors } from "../ui";

export interface UploadedMedia { ref: string; url: string }
export interface CaptureMediaValue { photo: UploadedMedia | null; video: UploadedMedia | null }

export function CaptureMediaInput({ purpose, value, onChange, onBusyChange }: {
  purpose: "product" | "intent";
  value: CaptureMediaValue;
  onChange: (value: CaptureMediaValue) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [microphone, requestMicrophone] = useMicrophonePermissions();
  const camera = useRef<CameraView>(null);
  const [mode, setMode] = useState<"picture" | "video">("picture");
  const [capturing, setCapturing] = useState(false);
  const [recording, setRecording] = useState(false);

  const capturePhoto = async () => {
    setCapturing(true);
    onBusyChange(true);
    try {
      const picture = await camera.current?.takePictureAsync({ quality: 0.6 });
      if (!picture?.uri) throw new Error("The camera did not return a picture.");
      const photo = await uploadCapture(picture.uri, undefined, { purpose });
      onChange({ ...value, photo });
    } catch (error) {
      Alert.alert("Capture failed", error instanceof Error ? error.message : String(error));
    } finally {
      setCapturing(false);
      onBusyChange(false);
    }
  };

  const captureVideo = async () => {
    if (recording) {
      camera.current?.stopRecording();
      return;
    }
    if (!microphone?.granted) {
      await requestMicrophone();
      return;
    }
    setCapturing(true);
    onBusyChange(true);
    setRecording(true);
    const startedAt = Date.now();
    try {
      const recordingResult = await camera.current?.recordAsync({ maxDuration: 15, maxFileSize: 50 * 1024 * 1024 });
      if (!recordingResult?.uri) throw new Error("The camera did not return a video.");
      const durationMs = Date.now() - startedAt;
      const contentType = recordingResult.uri.toLowerCase().endsWith(".mov") ? "video/quicktime" : "video/mp4";
      const video = await uploadCapture(recordingResult.uri, undefined, { contentType, durationMs, purpose });
      onChange({ ...value, video });
    } catch (error) {
      Alert.alert("Recording failed", error instanceof Error ? error.message : String(error));
    } finally {
      setRecording(false);
      setCapturing(false);
      onBusyChange(false);
    }
  };

  return <Section title={`${purpose === "intent" ? "Intent" : "Product"} media (optional)`}>
    <Text style={{ color: colors.muted, fontSize: 13 }}>
      Capture a photo, a video of up to 15 seconds, or both. The app never opens your media library.
    </Text>
    {value.photo ? <View style={{ height: 200, overflow: "hidden", borderRadius: 18 }}><Image source={{ uri: captureUrl(value.photo.ref), headers: { ...sessionHeaders(), ...participantHeaders() } }} style={{ flex: 1 }} resizeMode="cover" /></View> : null}
    {value.video ? <ProductVideo uri={value.video.url} /> : null}
    {value.photo ? <Button title="Remove photo" secondary onPress={() => onChange({ ...value, photo: null })} /> : null}
    {value.video ? <Button title="Remove video" secondary onPress={() => onChange({ ...value, video: null })} /> : null}
    {!permission?.granted ? (
      <>
        <Text style={{ color: colors.muted, fontSize: 13 }}>Camera access is used only for fresh {purpose} capture.</Text>
        <Button title="Allow camera" onPress={requestPermission} />
      </>
    ) : (
      <>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Pressable onPress={() => setMode("picture")}><Pill active={mode === "picture"}>PHOTO</Pill></Pressable>
          <Pressable onPress={() => setMode("video")}><Pill active={mode === "video"}>VIDEO · 15s MAX</Pill></Pressable>
        </View>
        <View style={{ height: 200, overflow: "hidden", borderRadius: 18, backgroundColor: "#0B0F0C" }}>
          <CameraView key={mode} ref={camera} style={{ flex: 1 }} facing="back" mode={mode} />
        </View>
        {mode === "picture" ? (
          <Button title={capturing ? "Capturing…" : "Capture photo"} disabled={capturing} onPress={capturePhoto} />
        ) : (
          <Button title={recording ? "Stop & upload video" : capturing ? "Uploading…" : "Record video"} disabled={capturing && !recording} onPress={captureVideo} />
        )}
      </>
    )}
  </Section>;
}
