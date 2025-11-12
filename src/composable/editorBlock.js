import { reactive, onMounted } from 'vue';
import { getBlocks } from '@/utils/getSharedData';
import { categories } from '@/utils/shared';

export function useEditorBlock(label) {
  const blocks = getBlocks();
  const block = reactive({
    details: {},
    category: {},
  });

  onMounted(() => {
    if (!label) return;

    const details = blocks[label];

    // Handle missing block definitions gracefully (e.g., after custom blocks are removed)
    if (!details) {
      console.warn(`[EditorBlock] Block definition not found for: ${label}`);
      block.details = { id: label, name: 'Unknown Block', description: 'Block definition missing' };
      block.category = { name: 'Unknown', id: 'unknown' };
      return;
    }

    block.details = { id: label, ...details };
    block.category = categories[details.category];
  });

  return block;
}
