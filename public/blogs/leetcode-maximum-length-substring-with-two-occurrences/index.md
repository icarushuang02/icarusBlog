## 题目描述

给你一个字符串 `s` ，请找出满足每个字符最多出现两次的最长子字符串，并返回该子字符串的** 最大 **长度。

 

示例 1：

**输入：** s = "bcbbbcba"

**输出：** 4

**解释：**

以下子字符串长度为 4，并且每个字符最多出现两次：`"bcbbbcba"`。

示例 2：

**输入：** s = "aaaa"

**输出：** 2

**解释：**

以下子字符串长度为 2，并且每个字符最多出现两次：`"aaaa"`。

 

**提示：**

	- `2 <= s.length <= 100`

	
	- `s` 仅由小写英文字母组成。

## 解法

```java
class Solution {
    public int maximumLengthSubstring(String s) {
        char[] target=s.toCharArray();
        int ans=0;
        int left=0;
        int[] cnt=new int[26];
        for(int right=0;right<s.length();right++){
            char cur=target[right];
            cnt[cur-'a']++;
            while(cnt[cur-'a']>2){
                cnt[target[left]-'a']--;
                left++;
            }
            ans=Math.max(ans,right-left+1);
        }
        return ans;
    }
}
```
