import React, { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Card, ColorDotButton, ColorSwatchRow, Header, Screen, useExpandable } from '../components/ui';
import { ThemeToggle } from '../components/ThemeToggle';
import { NotesStackParamList } from '../navigation/types';
import { palette } from '../theme';

type Props = NativeStackScreenProps<NotesStackParamList, 'NotesHome'>;

export default function NotesScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const { folders, setFolderColor, addFolder } = useData();
  const palettes = useExpandable();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(palette[0]);

  const totalNotes = folders.reduce((sum, f) => sum + f.notes.length, 0);

  const submit = () => {
    addFolder(name, color);
    setName('');
    setColor(palette[0]);
    setCreating(false);
  };

  return (
    <Screen>
      <ThemeToggle />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Header kicker={`${folders.length} folders · ${totalNotes} notes`} title="Notes" />
        <View style={{ paddingHorizontal: 20 }}>
          {folders.map((f) => (
            <Card key={f.id} style={{ marginBottom: 8, flexDirection: 'row', overflow: 'hidden' }}>
              <View style={{ width: 3, backgroundColor: f.color, borderRadius: 2, marginRight: 11 }} />
              <Pressable
                style={{ flex: 1 }}
                onPress={() => navigation.navigate('Folder', { folderId: f.id })}
              >
                <Text style={{ fontSize: 15, fontWeight: '500', color: theme.text }}>{f.name}</Text>
                <Text style={{ fontSize: 12, color: theme.neutral[500], marginTop: 2 }} numberOfLines={1}>
                  {f.notes[0]?.title ?? 'No notes yet'}
                </Text>
              </Pressable>
              <Text style={{ fontSize: 12, color: theme.neutral[600], marginRight: 10 }}>{f.notes.length}</Text>
              <ColorDotButton color={f.color} onPress={() => palettes.toggle(f.id)} />
              {palettes.isOpen(f.id) && (
                <View style={{ position: 'absolute', bottom: -40, left: 14 }}>
                  <ColorSwatchRow
                    selected={f.color}
                    onSelect={(c) => {
                      setFolderColor(f.id, c);
                      palettes.close();
                    }}
                  />
                </View>
              )}
            </Card>
          ))}

          {!creating ? (
            <Pressable
              onPress={() => setCreating(true)}
              style={{
                borderWidth: 1,
                borderStyle: 'dashed',
                borderColor: theme.neutral[700],
                borderRadius: 8,
                padding: 14,
                alignItems: 'center',
                marginTop: 8,
              }}
            >
              <Text style={{ color: theme.neutral[500], fontSize: 13.5 }}>+ New folder</Text>
            </Pressable>
          ) : (
            <Card style={{ marginTop: 8 }}>
              <TextInput
                placeholder="Folder name"
                placeholderTextColor={theme.neutral[600]}
                value={name}
                onChangeText={setName}
                style={{
                  backgroundColor: theme.neutral[900],
                  borderWidth: 1,
                  borderColor: theme.neutral[800],
                  borderRadius: 8,
                  padding: 11,
                  color: theme.text,
                  fontSize: 14,
                  marginBottom: 10,
                }}
              />
              <ColorSwatchRow selected={color} onSelect={setColor} />
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
                <Pressable onPress={() => setCreating(false)} style={{ flex: 1, alignItems: 'center', padding: 12 }}>
                  <Text style={{ color: theme.neutral[500] }}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={submit}
                  style={{ flex: 1, alignItems: 'center', padding: 12, borderWidth: 1, borderColor: theme.accent, borderRadius: 8 }}
                >
                  <Text style={{ color: theme.accentRamp[300], fontWeight: '500' }}>Add folder</Text>
                </Pressable>
              </View>
            </Card>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}
