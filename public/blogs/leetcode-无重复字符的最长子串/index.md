## 题目描述

给定一个字符串 `s` ，请你找出其中不含有重复字符的 **最长 子串**** **的长度。

 

**示例 1:**

```
**输入: **s = "abcabcbb"
**输出: **3 
**解释:** 因为无重复字符的最长子串是 "abc"，所以其长度为 3。注意 "bca" 和 "cab" 也是正确答案。
```

**示例 2:**

```
**输入: **s = "bbbbb"
**输出: **1
**解释: **因为无重复字符的最长子串是 "b"，所以其长度为 1。
```

**示例 3:**

```
**输入: **s = "pwwkew"
**输出: **3
**解释: **因为无重复字符的最长子串是 "wke"，所以其长度为 3。
     请注意，你的答案必须是 **子串 **的长度，"pwke" 是一个*子序列，*不是子串。
```

 

**提示：**

	- `0 <= s.length <= 5 * 104`

	- `s` 由英文字母、数字、符号和空格组成

## 解法

```java
class Solution {
    public int lengthOfLongestSubstring(String s) {
            Set<Character> occ = new HashSet<Character>();
          
            int ans=0; int rk=-1;
            for(int i=0;i < s.length();i++){
                if(s==null){
                    return 0;
                }
                if (i != 0) {
                // 左指针向右移动一格，移除一个字符
                occ.remove(s.charAt(i - 1));
            }

                
                while(rk+1 <s.length() && !occ.contains(s.charAt(rk+1))){
                    occ.add(s.charAt(rk+1));
                    rk++;
            }


                ans=Math.max(ans,rk+1-i);
            }
            return ans;
    }
}
```
