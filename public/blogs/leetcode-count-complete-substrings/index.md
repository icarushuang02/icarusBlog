## 题目描述

给你一个字符串 `word` 和一个整数 `k` 。

如果 `word` 的一个子字符串 `s` 满足以下条件，我们称它是 **完全字符串：**

	- `s` 中每个字符 **恰好** 出现 `k` 次。

	- 相邻字符在字母表中的顺序 **至多** 相差 `2` 。也就是说，`s` 中两个相邻字符 `c1` 和 `c2` ，它们在字母表中的位置相差** 至多** 为 `2` 。

请你返回 `word` 中 **完全** 子字符串的数目。

**子字符串** 指的是一个字符串中一段连续 **非空** 的字符序列。

 

示例 1：

```
**输入：**word = "igigee", k = 2
**输出：**3
**解释：**完全子字符串需要满足每个字符恰好出现 2 次，且相邻字符相差至多为 2 ：***igig***ee, igigee, ***igigee** 。*
```

示例 2：

```
**输入：**word = "aaabbbccc", k = 3
**输出：**6
**解释：**完全子字符串需要满足每个字符恰好出现 3 次，且相邻字符相差至多为 2 ：***aaa***bbbccc, aaa***bbb***ccc, aaabbb***ccc***, ***aaabbb***ccc, aaa***bbbccc***, ***aaabbbccc ***。
```

 

**提示：**

	- `1 <= word.length <= 105`

	- `word` 只包含小写英文字母。

	- `1 <= k <= word.length`

## 解法

```java
class Solution {
 public int countCompleteSubstrings(String word, int k) {
        int length = word.length();
        int i=0;
        int ans=0;
        char[] target;
        while(i<length){
            int start=i;
            i++;
            while( i<length&&(Math.abs(word.charAt(i)-word.charAt(i-1))<=2)){
                i++;
            };
            target=word.substring(start,i).toCharArray();
            for (int m=1;m<27&&m*k<=target.length;m++){
                int[] cnt=new int[26];
                for (int right=0;right<target.length;right++){
                    cnt[target[right]-'a']++;
                    if (right<k*m-1){
                        continue;
                    }
                    boolean ok = true;
                    for(int  a: cnt){
                        if (a>0&& a!=k){
                            ok=false;
                            break;
                        }
                    }
                    if (ok){
                        ans++;
                    }
                    cnt[target[right-k*m+1]-'a']--;
                }
            }

        }
        return ans;
    }
}
```
