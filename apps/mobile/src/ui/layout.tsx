import type { PropsWithChildren, ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { s } from "./styles";

/** Screen scaffold: eyebrow + title header over a scrolling page. */
export function Page({ title, eyebrow, children, right }: PropsWithChildren<{ title: string; eyebrow?: string; right?: ReactNode }>) {
  return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
        <View style={s.top}>
          <View>
            {eyebrow ? <Text style={s.eyebrow}>{eyebrow}</Text> : null}
            <Text style={s.title}>{title}</Text>
          </View>
          {right}
        </View>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

/** The white rounded container every piece of content sits in. */
export function Card({ children, style }: PropsWithChildren<{ style?: import("react-native").StyleProp<import("react-native").ViewStyle> }>) {
  return <View style={[s.card, style]}>{children}</View>;
}

/** A titled group of cards with an optional header action. */
export function Section({ title, action, children }: PropsWithChildren<{ title: string; action?: ReactNode }>) {
  return (
    <View style={s.section}>
      <View style={s.sectionHead}>
        <Text style={s.sectionTitle}>{title}</Text>
        {action}
      </View>
      {children}
    </View>
  );
}
