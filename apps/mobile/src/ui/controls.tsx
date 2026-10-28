import type { PropsWithChildren } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { s } from "./styles";

export function Label({ children }: PropsWithChildren) {
  return <Text style={s.label}>{children}</Text>;
}

export function Field(props: React.ComponentProps<typeof TextInput>) {
  return <TextInput placeholderTextColor="#98A29A" {...props} style={[s.input, props.style]} />;
}

export function Button({
  title,
  onPress,
  secondary = false,
  danger = false,
  disabled = false,
}: {
  title: string;
  onPress?: () => void;
  secondary?: boolean;
  /** Warning-action styling (disputes, destructive dev affordances). */
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityState={{ disabled }}
      style={[s.button, secondary && s.buttonSecondary, danger && (secondary ? s.buttonDangerSecondary : s.buttonDanger), disabled && { opacity: 0.45 }]}
    >
      <Text style={[s.buttonText, secondary && s.buttonTextSecondary, danger && secondary && s.buttonDangerTextSecondary]}>{title}</Text>
    </Pressable>
  );
}

export function Pill({ children, active = false }: PropsWithChildren<{ active?: boolean }>) {
  return (
    <View style={[s.pill, active && s.pillActive]}>
      <Text style={[s.pillText, active && s.pillTextActive]}>{children}</Text>
    </View>
  );
}
