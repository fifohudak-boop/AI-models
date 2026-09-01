import React, { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Card, Screen } from '../components/ui';
import { NotesStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<NotesStackParamList, 'Folder'>;

export default function FolderScreen({ route, navigation }: Props) {
  const { theme } = useTheme();
  const { folders, addNote } = useData();
  const folder = folders.find((f) => f.id === route.params.folderId);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  if (!folder) return null;

  const submit = () => {
    addNote(folder.id, { title: title || 'Untitled', when: 'now', body });
    setTitle('');
    setBody('');
    setCreating(false);
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={{ paddingTop: 60, paddingHorizontal: 20 }}>
          <Pressable onPress={() => navigation.goBack()}>
            <Text style={{ color: theme.accentRamp[300], fontSize: 13 }}>‹ Notes</Text>
          </Pressable>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: folder.color }} />
            <Text style={{ fontSize: 28, fontWeight: '500', color: theme.text }}>{folder.name}</Text>
          </View>

          <View style={{ marginTop: 16 }}>
            {folder.notes.map((n, i) => (
              <Card key={i} style={{ marginBottom: 8 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 14, fontWeight: '500', color: theme.text }}>{n.title}</Text>
                  <Text style={{ fontSize: 11, color: theme.neutral[600] }}>{n.when}</Text>
                </View>
                <Text style={{ fontSize: 12.5, lineHeight: 17, color: theme.neutral[500], marginTop: 6 }}>
                  {n.body}
                </Text>
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
                }}
              >
                <Text style={{ color: theme.neutral[500], fontSize: 13.5 }}>+ New note</Text>
              </Pressable>
            ) : (
              <Card>
                <TextInput
                  placeholder="Title"
                  placeholderTextColor={theme.neutral[600]}
                  value={title}
                  onChangeText={setTitle}
                  style={{
                    backgroundColor: theme.neutral[900],
                    borderWidth: 1,
                    borderColor: theme.neutral[800],
                    borderRadius: 8,
                    padding: 11,
                    color: theme.text,
                    fontSize: 14,
                    marginBottom: 8,
                  }}
                />
                <TextInput
                  placeholder="Note"
                  placeholderTextColor={theme.neutral[600]}
                  value={body}
                  onChangeText={setBody}
                  multiline
                  style={{
                    backgroundColor: theme.neutral[900],
                    borderWidth: 1,
                    borderColor: theme.neutral[800],
                    borderRadius: 8,
                    padding: 11,
                    color: theme.text,
                    fontSize: 14,
                    minHeight: 80,
                    textAlignVertical: 'top',
                    marginBottom: 10,
                  }}
                />
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <Pressable onPress={() => setCreating(false)} style={{ flex: 1, alignItems: 'center', padding: 12 }}>
                    <Text style={{ color: theme.neutral[500] }}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={submit}
                    style={{ flex: 1, alignItems: 'center', padding: 12, borderWidth: 1, borderColor: theme.accent, borderRadius: 8 }}
                  >
                    <Text style={{ color: theme.accentRamp[300], fontWeight: '500' }}>Save note</Text>
                  </Pressable>
                </View>
              </Card>
            )}
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}
