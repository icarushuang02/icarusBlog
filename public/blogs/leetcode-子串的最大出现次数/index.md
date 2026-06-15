## 题目描述

给你一个字符串 `s` ，请你返回满足以下条件且出现次数最大的 **任意** 子串的出现次数：

	- 子串中不同字母的数目必须小于等于 `maxLetters` 。

	- 子串的长度必须大于等于 `minSize` 且小于等于 `maxSize` 。

 

**示例 1：**

```
**输入：**s = "aababcaab", maxLetters = 2, minSize = 3, maxSize = 4
**输出：**2
**解释：**子串 "aab" 在原字符串中出现了 2 次。
它满足所有的要求：2 个不同的字母，长度为 3 （在 minSize 和 maxSize 范围内）。
```

**示例 2：**

```
**输入：**s = "aaaa", maxLetters = 1, minSize = 3, maxSize = 3
**输出：**2
**解释：**子串 "aaa" 在原字符串中出现了 2 次，且它们有重叠部分。
```

**示例 3：**

```
**输入：**s = "aabcabcab", maxLetters = 2, minSize = 2, maxSize = 3
**输出：**3
```

**示例 4：**

```
**输入：**s = "abcde", maxLetters = 2, minSize = 3, maxSize = 3
**输出：**0
```

 

**提示：**

	- `1 <= s.length <= 10^5`

	- `1 <= maxLetters <= 26`

	- `1 <= minSize <= maxSize <= min(26, s.length)`

	- `s` 只包含小写英文字母。

## 解法

```java
class Solution {
    public int maxFreq(String s, int maxLetters, int minSize, int maxSize) {
        char[] array = s.toCharArray();
        int n = array.length;
        int count = 0;
        //出现最多的子串
        int maxCount = 0;
        //记录不同字符
        Map<Character, Integer> mapToChar = new HashMap<>();
        //记录字串
        Map<String, Integer> mapTOString = new HashMap<>();
        //初始化窗口
        for (int i = 0; i < minSize; i++) {
            mapToChar.put(array[i], mapToChar.getOrDefault(array[i], 0) + 1);
            if (mapToChar.get(array[i]) == 1) {
                count++;
            }

        }
        if (count <= maxLetters) {
            mapTOString.put(s.substring(0, minSize), mapTOString.getOrDefault(s.substring(0, minSize), 0) + 1);
            maxCount = 1;
        }

        for (int j = minSize; j < n; j++) {
            // 添加右侧新字符
            char newChar = array[j];
            mapToChar.put(newChar, mapToChar.getOrDefault(newChar, 0) + 1);
            if (mapToChar.get(newChar) == 1) {
                count++;
            }

            // 移除左侧旧字符 (位置：j - minSize)
            char oldChar = array[j - minSize];
            mapToChar.put(oldChar, mapToChar.get(oldChar) - 1);
            if (mapToChar.get(oldChar) == 0) {
                count--;
            }
            if (count <= maxLetters) {
                String substr = s.substring(j - minSize + 1, j + 1);
                int freq = mapTOString.getOrDefault(substr, 0) + 1;
                mapTOString.put(substr, freq);
                maxCount = Math.max(maxCount, freq);
            }
        }
        return maxCount;
    }
}
```
